import { db } from '../db.js';
import { getBot } from '../bot/index.js';
import { escapeHtml } from '../shared/telegram-html.js';

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // как часто проверяем
const LOOKAHEAD_MS = 25 * 60 * 60 * 1000; // берём с запасом (макс. напоминание — 1440 мин, см. schedule-settings.ts)
const TZ_OFFSET_MS = 3 * 60 * 60 * 1000; // тот же упрощённый offset, что и в booking.ts

interface AppointmentRow {
  id: string;
  bot_id: number;
  master_id: number;
  client_id: number;
  slot_start: string;
  reminder_master_sent: boolean;
  reminder_client_sent: boolean;
  services: { name: string } | null;
  bots: { number: string } | null;
}

interface ScheduleSettingsRow {
  reminder_master_minutes_before: number;
  reminder_client_minutes_before: number;
}

function formatSlot(slotStart: string): string {
  const d = new Date(new Date(slotStart).getTime() + TZ_OFFSET_MS);
  const dateLabel = `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  const timeLabel = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  return `${dateLabel} в ${timeLabel}`;
}

async function checkReminders(): Promise<void> {
  const now = Date.now();

  const { data, error } = await db
    .from('appointments')
    .select('id, bot_id, master_id, client_id, slot_start, reminder_master_sent, reminder_client_sent, services(name), bots(number)')
    .eq('status', 'confirmed')
    .gt('slot_start', new Date(now).toISOString())
    .lte('slot_start', new Date(now + LOOKAHEAD_MS).toISOString())
    .or('reminder_master_sent.eq.false,reminder_client_sent.eq.false');

  if (error) {
    console.error('[AppointmentReminders] Ошибка выборки записей:', error.message);
    return;
  }

  const rows = (data ?? []) as unknown as AppointmentRow[];

  for (const appt of rows) {
    const uuid = appt.bots?.number;
    if (!uuid) continue;
    const bot = await getBot(uuid);
    if (!bot) continue;

    // Настроек расписания у мастера может уже не быть (например, если он
    // почистил профиль) — тогда просто пропускаем эту запись, не роняя джобу
    const { data: settingsData } = await db
      .from('master_schedule_settings')
      .select('reminder_master_minutes_before, reminder_client_minutes_before')
      .eq('master_id', appt.master_id)
      .eq('bot_id', appt.bot_id)
      .maybeSingle();

    const settings = settingsData as ScheduleSettingsRow | null;
    if (!settings) continue;

    const slotTime = new Date(appt.slot_start).getTime();
    const serviceName = appt.services?.name ?? 'услуга';

    if (!appt.reminder_master_sent && slotTime - settings.reminder_master_minutes_before * 60 * 1000 <= now) {
      let clientName = 'клиент';
      try {
        const clientChat = await bot.getChat(appt.client_id);
        if (clientChat.first_name) clientName = clientChat.first_name;
      } catch {
        // не критично
      }

      try {
        await bot.sendMessage(
          appt.master_id,
          `🔔 Напоминание: запись с <b>${escapeHtml(clientName)}</b> ${formatSlot(appt.slot_start)} — ${escapeHtml(serviceName)}.`,
          { parse_mode: 'HTML' }
        );
      } catch (err) {
        console.error(`[AppointmentReminders] Ошибка напоминания masterId=${appt.master_id}:`, err);
      }

      await db.from('appointments').update({ reminder_master_sent: true }).eq('id', appt.id);
    }

    if (!appt.reminder_client_sent && slotTime - settings.reminder_client_minutes_before * 60 * 1000 <= now) {
      const { data: masterProfile } = await db
        .from('masters_profiles')
        .select('name')
        .eq('master_id', appt.master_id)
        .eq('bot_id', appt.bot_id)
        .maybeSingle();

      const masterName = (masterProfile as { name: string } | null)?.name ?? 'мастер';

      try {
        await bot.sendMessage(
          appt.client_id,
          `🔔 Напоминание: запись у <b>${escapeHtml(masterName)}</b> ${formatSlot(appt.slot_start)} — ${escapeHtml(serviceName)}.`,
          { parse_mode: 'HTML' }
        );
      } catch (err) {
        console.error(`[AppointmentReminders] Ошибка напоминания clientId=${appt.client_id}:`, err);
      }

      await db.from('appointments').update({ reminder_client_sent: true }).eq('id', appt.id);
    }
  }
}

export function startAppointmentRemindersJob(): void {
  setInterval(() => {
    checkReminders().catch(err => console.error('[AppointmentReminders] Необработанная ошибка:', err));
  }, CHECK_INTERVAL_MS);
  console.log(`[AppointmentReminders] Джоб запущен, проверка каждые ${CHECK_INTERVAL_MS / 60000} мин`);
}
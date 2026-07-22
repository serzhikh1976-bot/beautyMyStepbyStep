import { InlineKeyboard } from 'ultra-telegram-framework';
import type { TelegramBot, SceneContext } from 'ultra-telegram-framework';
import { db, type BotRecord } from '../../db.js';
import { buildDaysKeyboard } from '../../scenes/schedule-settings.js';
import { escapeHtml } from '../../shared/telegram-html.js';

const DAY_LABELS: Record<number, string> = {
  1: 'Пн', 2: 'Вт', 3: 'Ср', 4: 'Чт', 5: 'Пт', 6: 'Сб', 7: 'Вс'
};

interface ScheduleSettings {
  working_days: number[];
  start_time: string;
  end_time: string;
  reminder_master_minutes_before: number;
  reminder_client_minutes_before: number;
}

export function registerScheduleHandlers(
  bot: TelegramBot<SceneContext>,
  record: BotRecord
): void {
  bot.match('📅 Календарь', async (ctx) => {
    const masterId = ctx.message && 'from' in ctx.message ? ctx.message.from?.id : undefined;
    if (!masterId) return;

    const { data } = await db
      .from('master_schedule_settings')
      .select('working_days, start_time, end_time, reminder_master_minutes_before, reminder_client_minutes_before')
      .eq('master_id', masterId)
      .eq('bot_id', record.id)
      .maybeSingle();

    const settings = data as ScheduleSettings | null;
    const keyboard = new InlineKeyboard().text(
      settings ? '✏️ Изменить расписание' : '⚙️ Настроить расписание',
      'schedule_edit'
    );

    if (!settings) {
      await ctx.reply(
        '📅 Расписание ещё не настроено. Клиенты не смогут записаться, пока вы не зададите рабочие часы.',
        { reply_markup: keyboard.toJSON() }
      );
      return;
    }

    const days = [...settings.working_days].sort((a, b) => a - b).map((d) => DAY_LABELS[d]).join(', ');
    const withDuration = new InlineKeyboard()
      .text('✏️ Изменить расписание', 'schedule_edit')
      .row()
      .text('⏱ Длительность услуг', 'duration_menu')
      .row()
      .text('📋 Мои записи', 'my_appointments_master');

    await ctx.reply(
      `📅 <b>Ваше расписание</b>\n\n` +
        `Рабочие дни: ${days}\n` +
        `Часы: ${settings.start_time.slice(0, 5)}–${settings.end_time.slice(0, 5)}\n` +
        `Напоминание вам: за ${settings.reminder_master_minutes_before} мин\n` +
        `Напоминание клиенту: за ${settings.reminder_client_minutes_before} мин`,
      { parse_mode: 'HTML', reply_markup: withDuration.toJSON() }
    );
  });

  bot.action('schedule_edit', async (ctx) => {
    const masterId = ctx.callbackQuery!.from.id;
    await ctx.answerCallbackQuery();

    const { data } = await db
      .from('master_schedule_settings')
      .select('working_days')
      .eq('master_id', masterId)
      .eq('bot_id', record.id)
      .maybeSingle();

    const currentDays = (data as { working_days: number[] } | null)?.working_days ?? [1, 2, 3, 4, 5];

    await ctx.reply(
      '📅 Выберите рабочие дни:',
      { reply_markup: buildDaysKeyboard(currentDays).toJSON() }
    );
    ctx.scene.enter('schedule_settings', { selectedDays: [...currentDays] });
  });

  // Список услуг мастера с текущей длительностью — тап открывает редактирование
  bot.action('duration_menu', async (ctx) => {
    const masterId = ctx.callbackQuery!.from.id;
    await ctx.answerCallbackQuery();

    const { data } = await db
      .from('master_services')
      .select('service_id, duration_minutes, services(name)')
      .eq('master_id', masterId)
      .eq('bot_id', record.id);

    const rows = (data as unknown as Array<{ service_id: number; duration_minutes: number; services: { name: string } | null }>) ?? [];

    if (rows.length === 0) {
      await ctx.reply('У вас пока не выбраны услуги. Сначала добавьте их через «⚙️ Редактировать» → «🔧 Услуги».');
      return;
    }

    const keyboard = new InlineKeyboard();
    rows.forEach((r, i) => {
      const name = r.services?.name ?? 'Услуга';
      keyboard.text(`${name} (${r.duration_minutes} мин)`, `duration_edit:${r.service_id}`);
      if ((i + 1) % 2 === 0) keyboard.row();
    });
    if (rows.length % 2 !== 0) keyboard.row();

    await ctx.reply('⏱ Выберите услугу, чтобы изменить длительность:', { reply_markup: keyboard.toJSON() });
  });

  bot.action(/^duration_edit:/, async (ctx) => {
    const serviceId = parseInt((ctx.callbackQuery!.data ?? '').replace('duration_edit:', ''));
    await ctx.answerCallbackQuery();
    await ctx.reply('⏱ Введите длительность в минутах (например 60):');
    ctx.scene.enter('edit_duration', { serviceId });
  });

  // Список предстоящих записей мастера
  bot.action('my_appointments_master', async (ctx) => {
    const masterId = ctx.callbackQuery!.from.id;
    await ctx.answerCallbackQuery();

    const { data } = await db
      .from('appointments')
      .select('id, client_id, service_id, slot_start, services(name)')
      .eq('master_id', masterId)
      .eq('bot_id', record.id)
      .eq('status', 'confirmed')
      .gte('slot_start', new Date().toISOString())
      .order('slot_start', { ascending: true })
      .limit(20);

    const rows = (data as unknown as Array<{ id: string; client_id: number; service_id: number; slot_start: string; services: { name: string } | null }>) ?? [];

    if (rows.length === 0) {
      await ctx.reply('📋 У вас пока нет предстоящих записей.');
      return;
    }

    let text = '📋 <b>Ваши предстоящие записи</b>\n\n';
    const keyboard = new InlineKeyboard();
    for (const r of rows) {
      let clientName = 'Клиент';
      try {
        const clientChat = await bot.getChat(r.client_id);
        if (clientChat.first_name) clientName = clientChat.first_name;
      } catch {
        // клиент мог заблокировать бота — оставляем дефолтное имя
      }

      const slotDate = new Date(r.slot_start);
      const kyiv = new Date(slotDate.getTime() + 3 * 60 * 60 * 1000);
      const dateLabel = `${String(kyiv.getUTCDate()).padStart(2, '0')}.${String(kyiv.getUTCMonth() + 1).padStart(2, '0')}`;
      const timeLabel = `${String(kyiv.getUTCHours()).padStart(2, '0')}:${String(kyiv.getUTCMinutes()).padStart(2, '0')}`;

      text += `🗓 ${dateLabel} в ${timeLabel} — ${escapeHtml(clientName)}, ${escapeHtml(r.services?.name ?? '—')}\n`;
      keyboard.text(`❌ Отменить ${dateLabel} ${timeLabel}`, `appt_cancel:${r.id}`).row();
    }

    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard.toJSON() });
  });
}
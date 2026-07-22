import { InlineKeyboard } from 'ultra-telegram-framework';
import type { TelegramBot, SceneContext } from 'ultra-telegram-framework';
import { db, type BotRecord } from '../../db.js';
import { escapeHtml } from '../../shared/telegram-html.js';

export function registerMyAppointmentsHandlers(
  bot: TelegramBot<SceneContext>,
  record: BotRecord
): void {
  bot.match('📅 Мои записи', async (ctx) => {
    const clientId = ctx.message && 'from' in ctx.message ? ctx.message.from?.id : undefined;
    if (!clientId) return;

    const { data } = await db
      .from('appointments')
      .select('id, master_id, service_id, slot_start, services(name)')
      .eq('client_id', clientId)
      .eq('bot_id', record.id)
      .eq('status', 'confirmed')
      .gte('slot_start', new Date().toISOString())
      .order('slot_start', { ascending: true })
      .limit(20);

    const rows = (data as unknown as Array<{ id: string; master_id: number; service_id: number; slot_start: string; services: { name: string } | null }>) ?? [];

    if (rows.length === 0) {
      await ctx.reply('📅 У вас пока нет предстоящих записей.');
      return;
    }

    let text = '📅 <b>Ваши предстоящие записи</b>\n\n';
    const keyboard = new InlineKeyboard();
    for (const r of rows) {
      const { data: masterProfile } = await db
        .from('masters_profiles')
        .select('name')
        .eq('master_id', r.master_id)
        .eq('bot_id', record.id)
        .maybeSingle();

      const masterName = (masterProfile as { name: string } | null)?.name ?? 'Мастер';

      const slotDate = new Date(r.slot_start);
      const kyiv = new Date(slotDate.getTime() + 3 * 60 * 60 * 1000);
      const dateLabel = `${String(kyiv.getUTCDate()).padStart(2, '0')}.${String(kyiv.getUTCMonth() + 1).padStart(2, '0')}`;
      const timeLabel = `${String(kyiv.getUTCHours()).padStart(2, '0')}:${String(kyiv.getUTCMinutes()).padStart(2, '0')}`;

      text += `🗓 ${dateLabel} в ${timeLabel} — ${escapeHtml(masterName)}, ${escapeHtml(r.services?.name ?? '—')}\n`;
      keyboard.text(`❌ Отменить ${dateLabel} ${timeLabel}`, `appt_cancel:${r.id}`).row();
    }

    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard.toJSON() });
  });
}
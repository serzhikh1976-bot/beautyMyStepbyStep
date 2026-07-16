import { WizardScene } from 'ultra-telegram-framework';
import type { SceneContext } from 'ultra-telegram-framework';
import { db } from '../db.js';
import { getAdminBot } from '../admin/bot.js';
import { escapeHtml } from '../shared/telegram-html.js';

export function createSupportMessageScene(botId: number) {
  return new WizardScene<SceneContext>(
    'support_message',

    async (ctx) => {
      if (!ctx.text) return;

      const text = ctx.text.trim();
      if (text.length < 3) {
        return ctx.reply('Слишком коротко. Опишите проблему подробнее:');
      }

      const telegramId = ctx.message && 'from' in ctx.message
        ? ctx.message.from?.id
        : undefined;
      if (!telegramId) return ctx.scene.leave();

      const [{ data: botRow }, { data: masterProfile }] = await Promise.all([
        db.from('bots').select('city_name, manager_telegram_id').eq('id', botId).maybeSingle(),
        db.from('masters_profiles').select('name').eq('master_id', telegramId).eq('bot_id', botId).maybeSingle()
      ]);

      const cityName = (botRow as { city_name: string; manager_telegram_id: number | null } | null)?.city_name ?? 'Город';
      const managerId = (botRow as { city_name: string; manager_telegram_id: number | null } | null)?.manager_telegram_id;
      const masterName = (masterProfile as { name: string } | null)?.name ?? 'Мастер';

      const superAdminId = process.env.SUPER_ADMIN_ID ? Number(process.env.SUPER_ADMIN_ID) : null;
      const targetId = managerId ?? superAdminId;

      if (!targetId) {
        console.error(`[support] Нет ни менеджера, ни SUPER_ADMIN_ID для города ${cityName}`);
        await ctx.reply('❌ Поддержка временно недоступна. Попробуйте позже.');
        return ctx.scene.leave();
      }

      const adminBot = getAdminBot();
      if (!adminBot) {
        await ctx.reply('❌ Поддержка временно недоступна. Попробуйте позже.');
        return ctx.scene.leave();
      }

      try {
        const sent = await adminBot.sendMessage(
          targetId,
          `🆘 <b>Поддержка — ${escapeHtml(masterName)}</b> (${escapeHtml(cityName)})\n\n${escapeHtml(text)}\n\n` +
            `↩️ Ответьте Reply на это сообщение, чтобы ответить мастеру.`,
          { parse_mode: 'HTML' }
        );

    await db.from('support_messages').insert({
          admin_message_id: sent.message_id,
          bot_id: botId,
          master_id: telegramId,
          message_text: text
        });

        await ctx.reply('✅ Сообщение отправлено в поддержку. Ответ придёт сюда же.');
      } catch (err) {
        console.error('[support] Ошибка отправки в admin-бот:', err);
        await ctx.reply('❌ Не удалось отправить. Попробуйте позже.');
      }

      ctx.scene.leave();
    }
  );
}
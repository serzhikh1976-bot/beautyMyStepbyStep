import { WizardScene } from 'ultra-telegram-framework';
import type { SceneContext } from 'ultra-telegram-framework';
import { db } from '../db.js';

export function createEditDurationScene(botId: number) {
  return new WizardScene<SceneContext>(
    'edit_duration',

    async (ctx) => {
      if (!ctx.text) return;

      const minutes = parseInt(ctx.text.trim());
      if (isNaN(minutes) || minutes < 5 || minutes > 600) {
        return ctx.reply('Введите число минут от 5 до 600 (10 часов):');
      }

      const telegramId = ctx.message && 'from' in ctx.message
        ? ctx.message.from?.id
        : undefined;
      if (!telegramId) return ctx.scene.leave();

      const serviceId = ctx.scene.state.serviceId as number;

      const { error } = await db
        .from('master_services')
        .update({ duration_minutes: minutes })
        .eq('master_id', telegramId)
        .eq('bot_id', botId)
        .eq('service_id', serviceId);

      if (error) {
        console.error('[editDuration] Ошибка сохранения:', error.message);
        await ctx.reply('❌ Ошибка сохранения. Попробуйте позже.');
      } else {
        await ctx.reply(`✅ Длительность сохранена: ${minutes} мин.\n\nОткройте «📅 Календарь» → «⏱ Длительность услуг», чтобы изменить другую.`);
      }

      ctx.scene.leave();
    }
  );
}
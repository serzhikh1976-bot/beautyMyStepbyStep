import type { TelegramBot, SceneContext } from 'ultra-telegram-framework';
import type { BotRecord } from '../../db.js';

export function registerSupportHandlers(
  bot: TelegramBot<SceneContext>,
  _record: BotRecord
): void {
  bot.match('🆘 Поддержка', async (ctx) => {
    await ctx.reply('✏️ Опишите вашу проблему одним сообщением — мы передадим её менеджеру:');
    ctx.scene.enter('support_message');
  });
}
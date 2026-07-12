import { InlineKeyboard, ReplyKeyboard } from 'ultra-telegram-framework';
import type { TelegramBot, SceneContext } from 'ultra-telegram-framework';
import { db, type BotRecord } from '../../db.js';
import { clearButtons } from '../helpers.js';
import { masterKeyboard } from '../keyboards.js';
import { saveRole } from '../roles.js';

export function registerStartHandlers(
  bot: TelegramBot<SceneContext>,
  record: BotRecord
): void {
  // /start — проверяем есть ли уже роль
  bot.command('start', async (ctx) => {
    const telegramId = ctx.message && 'from' in ctx.message
      ? ctx.message.from?.id
      : undefined;

    if (telegramId) {
      const { data } = await db
        .from('users')
        .select('role')
        .eq('bot_id', record.id)
        .eq('telegram_id', telegramId)
        .maybeSingle();

      if (data?.role === 'master') {
  // Роль сохраняется сразу при выборе, а профиль — только в конце визарда.
  // Если пользователь бросил регистрацию на середине, роль в БД уже
  // 'master', но masters_profiles ещё нет — без этой проверки он
  // навсегда застревал бы на "с возвращением" без входа в визард.
  const { data: profile } = await db
    .from('masters_profiles')
    .select('master_id')
    .eq('bot_id', record.id)
    .eq('master_id', telegramId)
    .maybeSingle();

  if (!profile) {
    await ctx.reply('👋 Похоже, вы не завершили регистрацию. Продолжим!\n\nКак вас зовут? Введите ваше имя:');
    ctx.scene.enter('master_registration');
    return;
  }

  return ctx.replyWithKeyboard(
    `👋 С возвращением в ${record.city_name}!`,
    masterKeyboard
  );
}

      if (data?.role === 'client') {
        const clientKeyboard = new ReplyKeyboard()
          .text('🔍 Найти мастера')
          .resized(true);

        return ctx.replyWithKeyboard(
          `👋 С возвращением в ${record.city_name}!`,
          clientKeyboard
        );
      }
    }

    // Новый пользователь — выбор роли
    const keyboard = new InlineKeyboard()
      .text('🔍 Я ищу мастера', 'role:client')
      .row()
      .text('💼 Я мастер', 'role:master');

    await ctx.reply(
      `👋 Добро пожаловать в ${record.city_name}!\n\nКто вы?`,
      { reply_markup: keyboard.toJSON() }
    );
  });

  // Выбор роли
  bot.action('role:client', async (ctx) => {
    const userId = ctx.callbackQuery!.from.id;
    try {
      await saveRole(record.id, userId, 'client');
      await ctx.answerCallbackQuery();
      await clearButtons(bot, ctx);

      const clientKeyboard = new ReplyKeyboard()
        .text('🔍 Найти мастера')
        .resized(true);

      await ctx.replyWithKeyboard(
        '✅ Вы зарегистрированы как клиент.\n\nНажмите кнопку чтобы найти мастера:',
        clientKeyboard
      );
    } catch (err) {
      console.error(`[${record.city_name}] Ошибка role:client userId=${userId}:`, err);
      await ctx.answerCallbackQuery('⚠️ Ошибка, попробуйте ещё раз').catch(() => {});
    }
  });

  bot.action('role:master', async (ctx) => {
    const userId = ctx.callbackQuery!.from.id;
    try {
      await saveRole(record.id, userId, 'master');
      await ctx.answerCallbackQuery();
      await clearButtons(bot, ctx);
      await ctx.reply('Как вас зовут? Введите ваше имя:');
      ctx.scene.enter('master_registration');
    } catch (err) {
      console.error(`[${record.city_name}] Ошибка role:master userId=${userId}:`, err);
      await ctx.answerCallbackQuery('⚠️ Ошибка, попробуйте ещё раз').catch(() => {});
    }
  });
}

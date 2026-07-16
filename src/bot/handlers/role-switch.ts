import { InlineKeyboard } from 'ultra-telegram-framework';
import type { TelegramBot, SceneContext } from 'ultra-telegram-framework';
import { db, type BotRecord } from '../../db.js';
import { clearButtons } from '../helpers.js';
import { masterKeyboard, clientKeyboard } from '../keyboards.js';

export function registerRoleSwitchHandlers(
  bot: TelegramBot<SceneContext>,
  record: BotRecord
): void {
  bot.match('🔄 Сменить роль', async (ctx) => {
    const telegramId = ctx.message && 'from' in ctx.message
      ? ctx.message.from?.id
      : undefined;
    if (!telegramId) return;

    const { data } = await db
      .from('users')
      .select('role')
      .eq('bot_id', record.id)
      .eq('telegram_id', telegramId)
      .maybeSingle();

    const currentRole = (data as { role: string } | null)?.role;
    const targetLabel = currentRole === 'master' ? 'клиента' : 'мастера';

    const keyboard = new InlineKeyboard()
      .text('✅ Да, сменить', 'role_switch_confirm')
      .text('Отмена', 'role_switch_cancel');

    await ctx.reply(
      `⚠️ Вы уверены, что хотите сменить роль на «${targetLabel}»?\n\n` +
        `Ваш текущий профиль не удалится — если передумаете, всё вернётся при обратной смене роли.`,
      { reply_markup: keyboard.toJSON() }
    );
  });

  bot.action('role_switch_cancel', async (ctx) => {
    await ctx.answerCallbackQuery('Отменено');
    await clearButtons(bot, ctx);
  });

  bot.action('role_switch_confirm', async (ctx) => {
    const telegramId = ctx.callbackQuery!.from.id;
    await ctx.answerCallbackQuery();
    await clearButtons(bot, ctx);

    const { data } = await db
      .from('users')
      .select('role')
      .eq('bot_id', record.id)
      .eq('telegram_id', telegramId)
      .maybeSingle();

    const currentRole = (data as { role: string } | null)?.role;

    if (currentRole === 'master') {
      // Мастер → клиент. Профиль не удаляем — просто ставим на паузу,
      // чтобы данные (услуги, прайс, фото) сохранились на случай, если
      // человек передумает и переключится обратно.
      await db.from('users').update({ role: 'client' }).eq('bot_id', record.id).eq('telegram_id', telegramId);
      await db.from('masters_profiles').update({ is_active: false }).eq('bot_id', record.id).eq('master_id', telegramId);

      await ctx.replyWithKeyboard(
        '✅ Теперь вы клиент. Ваш профиль мастера сохранён и поставлен на паузу — можно вернуться в любой момент.',
        clientKeyboard
      );
      return;
    }

    // Клиент → мастер
    await db.from('users').update({ role: 'master' }).eq('bot_id', record.id).eq('telegram_id', telegramId);

    const { data: existingProfile } = await db
      .from('masters_profiles')
      .select('master_id')
      .eq('bot_id', record.id)
      .eq('master_id', telegramId)
      .maybeSingle();

    if (existingProfile) {
      // Уже был мастером раньше, переключался туда-сюда — просто снимаем с паузы
      await db.from('masters_profiles').update({ is_active: true }).eq('bot_id', record.id).eq('master_id', telegramId);
      await ctx.replyWithKeyboard(
        `✅ С возвращением в ${record.city_name}! Ваш профиль мастера снова активен.`,
        masterKeyboard
      );
    } else {
      // Первый раз становится мастером — обычная регистрация
      await ctx.reply('✅ Теперь вы мастер!\n\nКак вас зовут? Введите ваше имя:');
      ctx.scene.enter('master_registration');
    }
  });
}
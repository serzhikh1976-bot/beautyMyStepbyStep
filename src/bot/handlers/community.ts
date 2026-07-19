import { InlineKeyboard } from 'ultra-telegram-framework';
import type { TelegramBot, SceneContext } from 'ultra-telegram-framework';
import type { BotRecord } from '../../db.js';
import { buildCommunityTopicLink, getCommunityInviteLink, isCommunityMember } from '../../community/topics.js';

export function registerCommunityHandlers(
  bot: TelegramBot<SceneContext>,
  record: BotRecord
): void {
  bot.match('👥 Сообщество', async (ctx) => {
    const topicId = record.community_topic_id;
    const userId = ctx.from?.id;

    if (!topicId) {
      await ctx.reply('😔 Чат сообщества для этого города пока не создан. Загляните позже!');
      return;
    }

    // t.me/c/... ссылки открываются только у тех, кто уже в группе —
    // остальным Telegram молча пишет "чат не существует". Поэтому сначала
    // проверяем членство и ведём либо сразу в тему, либо через инвайт.
    const alreadyMember = userId ? await isCommunityMember(userId) : false;

    if (alreadyMember) {
      const link = buildCommunityTopicLink(topicId);
      if (!link) {
        await ctx.reply('😔 Чат сообщества временно недоступен.');
        return;
      }

      const keyboard = new InlineKeyboard().url(`💬 Чат города ${record.city_name}`, link);
      await ctx.reply(
        `👥 Общайтесь с другими мастерами и клиентами города <b>${record.city_name}</b> — делитесь опытом, задавайте вопросы!`,
        { parse_mode: 'HTML', reply_markup: keyboard.toJSON() }
      );
      return;
    }

    const inviteLink = getCommunityInviteLink();
    if (!inviteLink) {
      await ctx.reply('😔 Чат сообщества временно недоступен.');
      return;
    }

    const keyboard = new InlineKeyboard().url('👋 Вступить в сообщество', inviteLink);
    await ctx.reply(
      `👥 Общайтесь с другими мастерами и клиентами Beauty-платформы!\n\n` +
        `Вступайте по кнопке ниже, а затем найдите тему своего города — <b>${record.city_name}</b>.`,
      { parse_mode: 'HTML', reply_markup: keyboard.toJSON() }
    );
  });
}
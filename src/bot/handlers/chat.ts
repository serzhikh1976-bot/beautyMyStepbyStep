import { InlineKeyboard } from 'ultra-telegram-framework';
import type { TelegramBot, SceneContext } from 'ultra-telegram-framework';
import { db, type BotRecord } from '../../db.js';
import { escapeHtml } from '../../shared/telegram-html.js';
import { clearButtons, sendTracked } from '../helpers.js';
import { endChatKeyboard, masterActionsKeyboard } from '../keyboards.js';

export function registerChatHandlers(
  bot: TelegramBot<SceneContext>,
  record: BotRecord
): void {
  // ── Анонимный чат ─────────────────────────────────────────────────────────

  // Клиент нажимает «💬 Написать мастеру»
  bot.action(/^chat:/, async (ctx) => {
    const clientId = ctx.callbackQuery!.from.id;
    const masterId = parseInt((ctx.callbackQuery!.data ?? '').replace('chat:', ''));
    await ctx.answerCallbackQuery();

    // Проверяем есть ли уже активный чат у клиента
    const { data: existing, error: existingError } = await db
      .from('active_chats')
      .select('id, master_id')
      .eq('client_id', clientId)
      .eq('bot_id', record.id)
      .eq('status', 'active')
      .maybeSingle();

    if (existingError) {
      console.error(`[${record.city_name}] Ошибка проверки активного чата:`, existingError.message);
    }

    if (existing) {
      const existingMasterId = (existing as { master_id: number }).master_id;

      const { data: existingMasterProfile } = await db
        .from('masters_profiles')
        .select('name')
        .eq('master_id', existingMasterId)
        .eq('bot_id', record.id)
        .maybeSingle();

      const masterName = (existingMasterProfile as { name: string } | null)?.name ?? 'мастером';
      return ctx.reply(`У вас уже есть активный чат с <b>${escapeHtml(masterName)}</b>. Сначала завершите его.`, { parse_mode: 'HTML' });
    }

    // Проверяем что мастер активен
    const { data: master } = await db
      .from('masters_profiles')
      .select('name, is_active')
      .eq('master_id', masterId)
      .eq('bot_id', record.id)
      .maybeSingle();

    if (!master || !(master as Record<string, unknown>).is_active) {
      return ctx.reply('Этот мастер сейчас недоступен.');
    }

    // Проверяем не забанил ли мастер этого клиента
    const { data: blocked } = await db
      .from('blocked_clients')
      .select('id')
      .eq('bot_id', record.id)
      .eq('master_id', masterId)
      .eq('client_id', clientId)
      .maybeSingle();

    if (blocked) {
      return ctx.reply('🚫 Вы больше не можете писать этому мастеру.');
    }

    const masterName = (master as Record<string, unknown>).name as string;

    // Создаём чат
    const { data: chat, error } = await db
      .from('active_chats')
      .insert({
        bot_id: record.id,
        client_id: clientId,
        master_id: masterId,
        status: 'active',
        updated_at: new Date().toISOString()
      })
      .select()
      .single();

    if (error || !chat) {
      return ctx.reply('Не удалось открыть чат. Попробуйте позже.');
    }

    const chatId = (chat as Record<string, unknown>).id as string;
    const masterKeyboardWithBan = masterActionsKeyboard(chatId);

    // Убираем кнопку «Написать мастеру» с карточки, по которой кликнул клиент —
    // иначе он может вернуться назад и нажать её повторно
    await clearButtons(bot, ctx);

    // Уведомляем клиента
    try {
      await sendTracked(bot, chatId, 'client', clientId, () =>
        ctx.reply(
          `💬 Чат с мастером <b>${escapeHtml(masterName)}</b> открыт!\n\nПишите ваш вопрос:`,
          { parse_mode: 'HTML', reply_markup: endChatKeyboard(chatId).toJSON() }
        )
      );
    } catch (err) {
      console.error(`[${record.city_name}] chat: ошибка уведомления клиента clientId=${clientId}:`, err);
    }

    // Уведомляем мастера и сохраняем message_id для маппинга Reply
    try {
      const notifMsg = await sendTracked(bot, chatId, 'master', masterId, () =>
        bot.sendMessage(
          masterId,
          `💬 Новый клиент хочет с вами пообщаться!\n\nОтвечайте Reply на сообщения клиента чтобы он вас видел.`,
          { reply_markup: masterKeyboardWithBan.toJSON() }
        )
      );
      const { error: logError } = await db.from('chat_messages').insert({
        chat_id: chatId,
        message_id: notifMsg.message_id
      });
      if (logError) console.error(`[${record.city_name}] chat: ошибка chat_messages insert:`, logError.message);
    } catch (err) {
      console.error(`[${record.city_name}] chat: ошибка уведомления мастера masterId=${masterId}:`, err);
    }
  });

  // Завершение чата
  // Шаг 1: просим подтверждение вместо мгновенного завершения —
  // защита от случайного нажатия
  bot.action(/^end_chat:/, async (ctx) => {
    const chatId = (ctx.callbackQuery!.data ?? '').replace('end_chat:', '');
    await ctx.answerCallbackQuery();

    const confirmKeyboard = new InlineKeyboard()
      .text('✅ Да, завершить', `end_chat_confirm:${chatId}`)
      .text('↩️ Отмена', `end_chat_cancel:${chatId}`);

    const msg = ctx.callbackQuery!.message;
    if (msg) {
      await bot.editMessageReplyMarkup(
        { chat_id: msg.chat.id, message_id: msg.message_id },
        { reply_markup: confirmKeyboard.toJSON() }
      );
    }
  });

  // Отмена — возвращаем обычную кнопку "Завершить диалог"
  bot.action(/^end_chat_cancel:/, async (ctx) => {
    const chatId = (ctx.callbackQuery!.data ?? '').replace('end_chat_cancel:', '');
    await ctx.answerCallbackQuery('Отменено');

    const msg = ctx.callbackQuery!.message;
    if (msg) {
      await bot.editMessageReplyMarkup(
        { chat_id: msg.chat.id, message_id: msg.message_id },
        { reply_markup: endChatKeyboard(chatId).toJSON() }
      );
    }
  });

  // Шаг 2: подтверждено — завершаем по-настоящему
  bot.action(/^end_chat_confirm:/, async (ctx) => {
    const userId = ctx.callbackQuery!.from.id;
    const chatId = (ctx.callbackQuery!.data ?? '').replace('end_chat_confirm:', '');
    await ctx.answerCallbackQuery();

    const { data: chat } = await db
      .from('active_chats')
      .select('client_id, master_id, status')
      .eq('id', chatId)
      .eq('bot_id', record.id)
      .maybeSingle();

    if (!chat || (chat as Record<string, unknown>).status !== 'active') {
      return ctx.reply('Чат уже завершён.');
    }

    const raw = chat as Record<string, unknown>;

    // Только реальный участник чата может его завершить
    if (userId !== raw.client_id && userId !== raw.master_id) {
      return;
    }

    // Убираем кнопки Да/Отмена с самого сообщения-подтверждения
    await clearButtons(bot, ctx);

    await db
      .from('active_chats')
      .update({ status: 'finished' })
      .eq('id', chatId)
      .eq('bot_id', record.id);

    const clientId = raw.client_id as number;
    const masterId = raw.master_id as number;

    // Имя мастера берём из его анкеты (это то имя, что видит клиент)
    const { data: masterProfile } = await db
      .from('masters_profiles')
      .select('name')
      .eq('master_id', masterId)
      .eq('bot_id', record.id)
      .maybeSingle();
    const masterName = (masterProfile as { name: string } | null)?.name ?? 'мастером';

    // Имя клиента в БД не хранится — берём текущее имя из Telegram
    let clientName = 'клиентом';
    try {
      const clientChat = await bot.getChat(clientId);
      if (clientChat.first_name) {
        clientName = clientChat.first_name;
      }
    } catch {
      // клиент мог заблокировать бота — оставляем дефолтное имя
    }

    // Уведомляем обоих, каждому — с именем собеседника
    try {
      await ctx.reply(
        userId === clientId
          ? `✅ Диалог с <b>${escapeHtml(masterName)}</b> завершён.`
          : `✅ Диалог с <b>${escapeHtml(clientName)}</b> завершён.`,
        { parse_mode: 'HTML' }
      );
    } catch (err) {
      console.error(`[${record.city_name}] end_chat_confirm: ошибка reply userId=${userId}:`, err);
    }

    const otherId = userId === clientId ? masterId : clientId;
    const otherMsg = userId === clientId
      ? `✅ Диалог с <b>${escapeHtml(clientName)}</b> завершён.`
      : `✅ Диалог с <b>${escapeHtml(masterName)}</b> завершён.`;

    try {
      await bot.sendMessage(otherId, otherMsg, { parse_mode: 'HTML' });
    } catch (err) {
      // Второй участник мог заблокировать бота — не критично, чат уже завершён
      console.error(`[${record.city_name}] end_chat_confirm: ошибка уведомления otherId=${otherId}:`, err);
    }
  });

  // Продление чата по кнопке из предупреждения об автозакрытии.
  // Разрешено только один раз за всю жизнь чата — извлекаем и проверяем extended.
  bot.action(/^extend_chat:/, async (ctx) => {
    const userId = ctx.callbackQuery!.from.id;
    const chatId = (ctx.callbackQuery!.data ?? '').replace('extend_chat:', '');
    await ctx.answerCallbackQuery();

    const { data: chat } = await db
      .from('active_chats')
      .select('client_id, master_id, status, extended')
      .eq('id', chatId)
      .eq('bot_id', record.id)
      .maybeSingle();

    if (!chat || (chat as Record<string, unknown>).status !== 'active') {
      await clearButtons(bot, ctx);
      return ctx.reply('Этот диалог уже закрыт.');
    }

    const raw = chat as Record<string, unknown>;

    // Только участник чата может продлить
    if (userId !== raw.client_id && userId !== raw.master_id) {
      return;
    }

    if (raw.extended) {
      await clearButtons(bot, ctx);
      return ctx.reply('Этот диалог уже продлевали — повторное продление недоступно.');
    }

    await clearButtons(bot, ctx);

    await db
      .from('active_chats')
      .update({
        updated_at: new Date().toISOString(),
        warning_sent: false,
        extended: true
      })
      .eq('id', chatId)
      .eq('bot_id', record.id);

    const clientId = raw.client_id as number;
    const masterId = raw.master_id as number;

    // Имя мастера берём из анкеты, имя клиента — из Telegram (в БД не хранится)
    const { data: masterProfile } = await db
      .from('masters_profiles')
      .select('name')
      .eq('master_id', masterId)
      .eq('bot_id', record.id)
      .maybeSingle();
    const masterName = (masterProfile as { name: string } | null)?.name ?? 'мастером';

    let clientName = 'клиентом';
    try {
      const clientChat = await bot.getChat(clientId);
      if (clientChat.first_name) clientName = clientChat.first_name;
    } catch {
      // клиент мог заблокировать бота — оставляем дефолтное имя
    }

    try {
      await ctx.reply('✅ Вы продлили диалог ещё на 3 часа.');
    } catch (err) {
      console.error(`[${record.city_name}] extend_chat: ошибка reply userId=${userId}:`, err);
    }

    const otherId = userId === clientId ? masterId : clientId;
    const clickerName = userId === clientId ? clientName : masterName;

    try {
      await bot.sendMessage(
        otherId,
        `✅ Диалог продлён ещё на 3 часа собеседником (${escapeHtml(clickerName)}).`,
        { parse_mode: 'HTML' }
      );
    } catch (err) {
      // Второй участник мог заблокировать бота — не критично, продление уже сохранено
      console.error(`[${record.city_name}] extend_chat: ошибка уведомления otherId=${otherId}:`, err);
    }
  });

  // Бан клиента мастером
  // Шаг 1: просим подтверждение — действие серьёзное и необратимое
  bot.action(/^ban_client:/, async (ctx) => {
    const chatId = (ctx.callbackQuery!.data ?? '').replace('ban_client:', '');
    await ctx.answerCallbackQuery();

    const confirmKeyboard = new InlineKeyboard()
      .text('🚫 Да, забанить', `ban_client_confirm:${chatId}`)
      .text('↩️ Отмена', `ban_client_cancel:${chatId}`);

    const msg = ctx.callbackQuery!.message;
    if (msg) {
      await bot.editMessageReplyMarkup(
        { chat_id: msg.chat.id, message_id: msg.message_id },
        { reply_markup: confirmKeyboard.toJSON() }
      );
    }
  });

  // Отмена — возвращаем обычные кнопки мастера
  bot.action(/^ban_client_cancel:/, async (ctx) => {
    const chatId = (ctx.callbackQuery!.data ?? '').replace('ban_client_cancel:', '');
    await ctx.answerCallbackQuery('Отменено');

    const msg = ctx.callbackQuery!.message;
    if (msg) {
      await bot.editMessageReplyMarkup(
        { chat_id: msg.chat.id, message_id: msg.message_id },
        { reply_markup: masterActionsKeyboard(chatId).toJSON() }
      );
    }
  });

  // Шаг 2: подтверждено — баним по-настоящему
  bot.action(/^ban_client_confirm:/, async (ctx) => {
    const userId = ctx.callbackQuery!.from.id;
    const chatId = (ctx.callbackQuery!.data ?? '').replace('ban_client_confirm:', '');
    await ctx.answerCallbackQuery();

    const { data: chat } = await db
      .from('active_chats')
      .select('client_id, master_id, status')
      .eq('id', chatId)
      .eq('bot_id', record.id)
      .maybeSingle();

    if (!chat) {
      return ctx.reply('Чат не найден.');
    }

    const raw = chat as Record<string, unknown>;
    const clientId = raw.client_id as number;
    const masterId = raw.master_id as number;

    // Банить может только сам мастер этого чата
    if (userId !== masterId) {
      return;
    }

    // Убираем кнопки Да/Отмена с самого сообщения-подтверждения
    await clearButtons(bot, ctx);

    // Если чат ещё активен — заодно завершаем его
    if (raw.status === 'active') {
      await db
        .from('active_chats')
        .update({ status: 'finished' })
        .eq('id', chatId)
        .eq('bot_id', record.id);
    }

    // Записываем бан. Если пара уже забанена (повторный клик, гонка) —
    // просто игнорируем конфликт уникальности.
    const { error: banError } = await db.from('blocked_clients').insert({
      bot_id: record.id,
      master_id: masterId,
      client_id: clientId
    });

    if (banError && banError.code !== '23505') {
      console.error(`[${record.city_name}] Ошибка записи бана:`, banError.message);
      return ctx.reply('⚠️ Не удалось забанить клиента. Попробуйте ещё раз.');
    }

    await ctx.reply('🚫 Клиент забанен. Он больше не сможет вам писать.');
    try {
      await bot.sendMessage(clientId, '🚫 Мастер ограничил переписку с вами. Вы больше не можете писать этому мастеру.');
    } catch (err) {
      // Клиент мог заблокировать бота — бан всё равно записан
      console.error(`[${record.city_name}] ban_client_confirm: ошибка уведомления clientId=${clientId}:`, err);
    }
  });

  // ── Универсальный роутер сообщений чата ──────────────────────────────────

  // Если сообщение не попало ни в один активный чат: зарегистрированному
  // клиенту/мастеру говорим "нет активных чатов", а не "не понимаю команду" —
  // это два разных по смыслу случая.
  async function noActiveChatMessage(userId: number): Promise<string> {
    const { data: userRow } = await db
      .from('users')
      .select('role')
      .eq('bot_id', record.id)
      .eq('telegram_id', userId)
      .maybeSingle();

    if ((userRow as { role: string } | null)?.role) {
      return '💬 У вас нет активных чатов.';
    }

    return 'Не понимаю эту команду 🤔\n/help — список команд';
  }

  async function routeChatMessage(
    userId: number,
    fromMsg: { first_name?: string } | undefined,
    text: string | null,
    photoFileId: string | null
  ): Promise<boolean> {
    // Клиент → ищем его активный чат
    const { data: clientChat } = await db
      .from('active_chats')
      .select('id, master_id')
      .eq('client_id', userId)
      .eq('bot_id', record.id)
      .eq('status', 'active')
      .maybeSingle();

    if (clientChat) {
      const raw = clientChat as Record<string, unknown>;
      const clientName = fromMsg?.first_name ?? 'Клиент';

      if (photoFileId) {
        try {
          const sentMsg = await sendTracked(bot, raw.id as string, 'master', raw.master_id as number, () =>
            bot.sendPhoto(
              raw.master_id as number,
              photoFileId,
              {
                caption: `📸 <b>${escapeHtml(clientName)}</b>`,
                parse_mode: 'HTML',
                reply_markup: masterActionsKeyboard(raw.id as string).toJSON()
              }
            )
          );
          await db.from('chat_messages').insert({ chat_id: raw.id, message_id: sentMsg.message_id });
          await db.from('chat_message_log').insert({ chat_id: raw.id, sender_id: userId, photo_ids: [photoFileId] });
        } catch (err) {
          console.error(`[${record.city_name}] routeChatMessage: ошибка отправки фото мастеру masterId=${raw.master_id}:`, err);
        }
      } else if (text) {
        try {
          const sentMsg = await sendTracked(bot, raw.id as string, 'master', raw.master_id as number, () =>
            bot.sendMessage(
              raw.master_id as number,
              `💬 <b>${escapeHtml(clientName)}:</b> ${escapeHtml(text)}`,
              {
                parse_mode: 'HTML',
                reply_markup: masterActionsKeyboard(raw.id as string).toJSON()
              }
            )
          );
          await db.from('chat_messages').insert({ chat_id: raw.id, message_id: sentMsg.message_id });
          await db.from('chat_message_log').insert({ chat_id: raw.id, sender_id: userId, text });
        } catch (err) {
          console.error(`[${record.city_name}] routeChatMessage: ошибка отправки текста мастеру masterId=${raw.master_id}:`, err);
        }
      }

      await db.from('active_chats').update({ updated_at: new Date().toISOString(), warning_sent: false }).eq('id', raw.id);
      return true;
    }

    // Мастер → проверяем его активные чаты
    const { data: masterChats } = await db
      .from('active_chats')
      .select('id, client_id')
      .eq('master_id', userId)
      .eq('bot_id', record.id)
      .eq('status', 'active');

    if (masterChats && masterChats.length > 0) {
      let targetChat: Record<string, unknown> | null = null;

      if (photoFileId === null) {
        // Для текста пробуем найти по reply (только для текстовых сообщений)
      }

      if (!targetChat && masterChats.length === 1) {
        targetChat = masterChats[0] as Record<string, unknown>;
      }

      if (targetChat) {
        const { data: masterProfile } = await db
          .from('masters_profiles')
          .select('name')
          .eq('master_id', userId)
          .eq('bot_id', record.id)
          .maybeSingle();

        const masterName = (masterProfile as { name: string } | null)?.name ?? 'Мастер';

        if (photoFileId) {
          try {
            await sendTracked(bot, targetChat.id as string, 'client', targetChat.client_id as number, () =>
              bot.sendPhoto(
                targetChat.client_id as number,
                photoFileId,
                {
                  caption: `📸 <b>${escapeHtml(masterName)}</b>`,
                  parse_mode: 'HTML',
                  reply_markup: endChatKeyboard(targetChat.id as string).toJSON()
                }
              )
            );
            await db.from('chat_message_log').insert({ chat_id: targetChat.id, sender_id: userId, photo_ids: [photoFileId] });
          } catch (err) {
            console.error(`[${record.city_name}] routeChatMessage: ошибка отправки фото клиенту clientId=${targetChat.client_id}:`, err);
          }
        } else if (text) {
          try {
            await sendTracked(bot, targetChat.id as string, 'client', targetChat.client_id as number, () =>
              bot.sendMessage(
                targetChat.client_id as number,
                `💼 <b>${escapeHtml(masterName)}:</b> ${escapeHtml(text)}`,
                {
                  parse_mode: 'HTML',
                  reply_markup: endChatKeyboard(targetChat.id as string).toJSON()
                }
              )
            );
            await db.from('chat_message_log').insert({ chat_id: targetChat.id, sender_id: userId, text });
          } catch (err) {
            console.error(`[${record.city_name}] routeChatMessage: ошибка отправки текста клиенту clientId=${targetChat.client_id}:`, err);
          }
        }

        await db.from('active_chats').update({ updated_at: new Date().toISOString(), warning_sent: false }).eq('id', targetChat.id);
        return true;
      }
      return true; // в чате но не знаем кому — не показываем fallback
    }

    return false; // не в чате
  }

  // Текстовые сообщения
  bot.on('text', async (ctx) => {
    const userId = ctx.message && 'from' in ctx.message ? ctx.message.from?.id : undefined;
    if (!userId) return;

    const text = ctx.text ?? '';
    const fromMsg = ctx.message && 'from' in ctx.message ? ctx.message.from : undefined;

    // Проверяем reply для мастера с несколькими чатами
    const msg = ctx.message as unknown as Record<string, unknown>;
    const replyToId = (msg?.reply_to_message as Record<string, unknown> | undefined)
      ?.message_id as number | undefined;

    if (replyToId) {
      const { data: chatMsg, error: chatMsgError } = await db
        .from('chat_messages')
        .select('chat_id, active_chats!inner(id, client_id, status, bot_id)')
        .eq('message_id', replyToId)
        .eq('active_chats.bot_id', record.id)
        .maybeSingle();

      if (chatMsgError) {
        console.error(`[${record.city_name}] Ошибка поиска chat_messages:`, chatMsgError.message);
      }

      const found = (chatMsg as Record<string, unknown> | null)
        ?.active_chats as Record<string, unknown> | null;

      // Нашли, на какой чат отвечает мастер через Reply, но этот чат уже
      // не активен — явно говорим об этом и НЕ проваливаемся дальше в
      // авто-роутинг (иначе сообщение молча улетит в другой, случайно
      // оставшийся активным чат, а мастер даже не узнает об этом)
      if (found && found.status !== 'active') {
        await ctx.reply('⚠️ Этот диалог уже завершён. Сообщение не отправлено.');
        return;
      }

      if (found?.status === 'active') {
        const { data: masterProfile } = await db
          .from('masters_profiles')
          .select('name')
          .eq('master_id', userId)
          .eq('bot_id', record.id)
          .maybeSingle();

        const masterName = (masterProfile as { name: string } | null)?.name ?? 'Мастер';

        await sendTracked(bot, found.id as string, 'client', found.client_id as number, () =>
          bot.sendMessage(
            found.client_id as number,
            `💼 <b>${escapeHtml(masterName)}:</b> ${escapeHtml(text)}`,
            {
              parse_mode: 'HTML',
              reply_markup: endChatKeyboard(found.id as string).toJSON()
            }
          )
        );
        await db.from('chat_message_log').insert({ chat_id: found.id, sender_id: userId, text });
        await db.from('active_chats').update({ updated_at: new Date().toISOString(), warning_sent: false }).eq('id', found.id);
        return;
      }
    }

    // --- ДОБАВЛЕННАЯ ПРОВЕРКА ДЛЯ МАСТЕРА С НЕСКОЛЬКИМИ ЧАТАМИ ---
    // Если reply не было (или не помог), проверим, не пытается ли мастер с несколькими чатами отправить сообщение без reply
    if (!replyToId) {
      const { data: masterChats } = await db
        .from('active_chats')
        .select('id')
        .eq('master_id', userId)
        .eq('bot_id', record.id)
        .eq('status', 'active');

      if (masterChats && masterChats.length > 1) {
        await ctx.reply(
          '⚠️ У вас несколько активных чатов. Чтобы ответить конкретному клиенту, используйте Reply (ответ) на его сообщение.'
        );
        return; // не идём дальше
      }
    }
    // --- КОНЕЦ ДОБАВЛЕННОЙ ПРОВЕРКИ ---

    const handled = await routeChatMessage(userId, fromMsg, text, null);
    if (!handled) {
      await ctx.reply(await noActiveChatMessage(userId));
    }
  });

  // Фото
  bot.on('photo', async (ctx) => {
    const userId = ctx.message && 'from' in ctx.message ? ctx.message.from?.id : undefined;
    if (!userId) return;

    const photoSizes = ctx.message && 'photo' in ctx.message
      ? (ctx.message as unknown as Record<string, unknown>).photo as Array<{ file_id: string }>
      : undefined;

    if (!photoSizes || photoSizes.length === 0) return;

    const fileId = photoSizes[photoSizes.length - 1].file_id;
    const fromMsg = ctx.message && 'from' in ctx.message ? ctx.message.from : undefined;

    // --- ДОБАВЛЕННАЯ ПРОВЕРКА ДЛЯ МАСТЕРА С НЕСКОЛЬКИМИ ЧАТАМИ ---
    // Проверяем, не пытается ли мастер с несколькими чатами отправить фото без reply
    const { data: masterChats } = await db
      .from('active_chats')
      .select('id')
      .eq('master_id', userId)
      .eq('bot_id', record.id)
      .eq('status', 'active');

    if (masterChats && masterChats.length > 1) {
      await ctx.reply(
        '⚠️ У вас несколько активных чатов. Чтобы отправить фото конкретному клиенту, используйте Reply (ответ) на его сообщение.'
      );
      return; // не отправляем фото
    }
    // --- КОНЕЦ ДОБАВЛЕННОЙ ПРОВЕРКИ ---

    const handled = await routeChatMessage(userId, fromMsg, null, fileId);
    if (!handled) {
      await ctx.reply(await noActiveChatMessage(userId));
    }
  });
}
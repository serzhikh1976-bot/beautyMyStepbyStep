import { InlineKeyboard, ReplyKeyboard } from 'ultra-telegram-framework';

// Reply-клавиатура для мастера
export const masterKeyboard = new ReplyKeyboard()
  .text('👤 Мой профиль')
  .resized(true);

// Кнопка «Завершить диалог» — прикрепляется к КАЖДОМУ сообщению в чат-тоннеле,
// а не только к первому уведомлению, чтобы при нескольких активных чатах
// можно было завершить нужный диалог прямо под свежим сообщением от этого
// клиента, не листая историю в поисках самого первого уведомления.
export const endChatKeyboard = (chatId: string) =>
  new InlineKeyboard().text('❌ Завершить диалог', `end_chat:${chatId}`);

// То же самое, но с кнопкой бана — показывается только мастеру
// (клиент не может банить мастера, поэтому у него только End)
export const masterActionsKeyboard = (chatId: string) =>
  new InlineKeyboard()
    .text('❌ Завершить диалог', `end_chat:${chatId}`)
    .text('🚫 Забанить', `ban_client:${chatId}`);

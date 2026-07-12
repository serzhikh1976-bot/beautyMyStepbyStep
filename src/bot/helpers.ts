import type { TelegramBot } from 'ultra-telegram-framework';
import type { SceneContext } from 'ultra-telegram-framework';
import { db } from '../db.js';

// Убирает inline-кнопки с сообщения, на кнопку которого только что кликнули.
// Для одноразовых действий (выбор роли, подтверждения) — чтобы нельзя было
// случайно повторно нажать на уже отработавшую кнопку в истории чата.
export async function clearButtons(
  bot: TelegramBot<SceneContext>,
  ctx: SceneContext
): Promise<void> {
  const msg = ctx.callbackQuery?.message;
  if (!msg) return;
  try {
    await bot.editMessageReplyMarkup(
      { chat_id: msg.chat.id, message_id: msg.message_id },
      { reply_markup: { inline_keyboard: [] } }
    );
  } catch {
    // сообщение удалено или устарело для редактирования — не критично
  }
}

// только на САМОМ СВЕЖЕМ сообщении с этой стороны чата — предыдущее
// сообщение с кнопками (если было) визуально очищается. Это защищает
// от случайного клика по устаревшей кнопке где-то в истории переписки
// (особенно важно для «Забанить» — иначе можно случайно повторно
// забанить уже разбаненного клиента, кликнув по старому сообщению).
export async function sendTracked<T extends { message_id: number }>(
  bot: TelegramBot<SceneContext>,
  chatId: string,
  side: 'master' | 'client',
  recipientId: number,
  send: () => Promise<T>
): Promise<T> {
  const column = side === 'master' ? 'last_master_button_msg_id' : 'last_client_button_msg_id';

  const { data: prev } = await db.from('active_chats').select(column).eq('id', chatId).maybeSingle();
  const prevMsgId = (prev as Record<string, unknown> | null)?.[column] as number | null | undefined;

  if (prevMsgId) {
    try {
      await bot.editMessageReplyMarkup(
        { chat_id: recipientId, message_id: prevMsgId },
        { reply_markup: { inline_keyboard: [] } }
      );
    } catch {
      // Сообщение могли удалить или оно устарело для редактирования (>48ч) — не критично
    }
  }

  const sent = await send();

  await db.from('active_chats').update({ [column]: sent.message_id }).eq('id', chatId);

  return sent;
}

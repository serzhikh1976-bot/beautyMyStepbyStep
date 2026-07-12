import { InlineKeyboard } from 'ultra-telegram-framework';
import { db } from '../db.js';
import { getBot } from '../bot/index.js';
import { escapeHtml } from '../shared/telegram-html.js';
import { sendTracked } from '../bot/helpers.js';

const WARNING_AFTER_MS = 2 * 60 * 60 * 1000; // 2 часа бездействия — шлём предупреждение
const CLOSE_AFTER_MS = 3 * 60 * 60 * 1000;   // 3 часа бездействия — закрываем
const CHECK_INTERVAL_MS = 5 * 60 * 1000;     // как часто проверяем


// const WARNING_AFTER_MS = 2 * 60 * 1000;  // 2 минуты бездействия — шлём предупреждение (ТЕСТ)
// const CLOSE_AFTER_MS = 3 * 60 * 1000;    // 3 минуты бездействия — закрываем (ТЕСТ)
// const CHECK_INTERVAL_MS = 20 * 1000;     // проверяем каждые 20 сек (ТЕСТ)

interface ChatRow {
  id: string;
  bot_id: number;
  client_id: number;
  master_id: number;
  updated_at: string;
  extended: boolean;
  bots: { number: string } | null;
}

async function getMasterName(masterId: number, botId: number): Promise<string> {
  const { data } = await db
    .from('masters_profiles')
    .select('name')
    .eq('master_id', masterId)
    .eq('bot_id', botId)
    .maybeSingle();
  return (data as { name: string } | null)?.name ?? 'мастером';
}

// Шлём предупреждение о скором закрытии обоим участникам чата
async function sendWarning(chat: ChatRow): Promise<void> {
  const uuid = chat.bots?.number;
  if (!uuid) return;
  const bot = await getBot(uuid);
  if (!bot) return;

  const masterName = await getMasterName(chat.master_id, chat.bot_id);

  let clientName = 'клиентом';
  try {
    const clientChat = await bot.getChat(chat.client_id);
    if (clientChat.first_name) clientName = clientChat.first_name;
  } catch {
    // клиент мог заблокировать бота — оставляем дефолтное имя
  }

  // Кнопку продления показываем только если продление ещё не использовали —
  // после первого продления второго шанса нет
  const keyboard = chat.extended
    ? undefined
    : new InlineKeyboard().text('🔄 Продлить на 3 часа', `extend_chat:${chat.id}`);

  try {
    await sendTracked(bot, chat.id, 'client', chat.client_id, () =>
      bot.sendMessage(
        chat.client_id,
        `⏰ Диалог с <b>${escapeHtml(masterName)}</b> закроется через час из-за неактивности.`,
        { parse_mode: 'HTML', ...(keyboard ? { reply_markup: keyboard.toJSON() } : {}) }
      )
    );
  } catch (err) {
    console.error(`[AutoCloseChats] Ошибка предупреждения clientId=${chat.client_id}:`, err);
  }

  try {
    await sendTracked(bot, chat.id, 'master', chat.master_id, () =>
      bot.sendMessage(
        chat.master_id,
        `⏰ Диалог с <b>${escapeHtml(clientName)}</b> закроется через час из-за неактивности.`,
        { parse_mode: 'HTML', ...(keyboard ? { reply_markup: keyboard.toJSON() } : {}) }
      )
    );
  } catch (err) {
    console.error(`[AutoCloseChats] Ошибка предупреждения masterId=${chat.master_id}:`, err);
  }

  await db.from('active_chats').update({ warning_sent: true }).eq('id', chat.id);
}

// Закрываем чат по таймауту и уведомляем обоих
async function closeChat(chat: ChatRow): Promise<void> {
  const uuid = chat.bots?.number;
  if (!uuid) return;
  const bot = await getBot(uuid);
  if (!bot) return;

  const masterName = await getMasterName(chat.master_id, chat.bot_id);

  let clientName = 'клиентом';
  try {
    const clientChat = await bot.getChat(chat.client_id);
    if (clientChat.first_name) clientName = clientChat.first_name;
  } catch {
    // клиент мог заблокировать бота — оставляем дефолтное имя
  }

  await db.from('active_chats').update({ status: 'finished' }).eq('id', chat.id);

  try {
    await bot.sendMessage(
      chat.client_id,
      `⏱ Диалог с <b>${escapeHtml(masterName)}</b> закрыт автоматически из-за неактивности.`,
      { parse_mode: 'HTML' }
    );
  } catch (err) {
    console.error(`[AutoCloseChats] Ошибка уведомления clientId=${chat.client_id}:`, err);
  }

  try {
    await bot.sendMessage(
      chat.master_id,
      `⏱ Диалог с <b>${escapeHtml(clientName)}</b> закрыт автоматически из-за неактивности.`,
      { parse_mode: 'HTML' }
    );
  } catch (err) {
    console.error(`[AutoCloseChats] Ошибка уведомления masterId=${chat.master_id}:`, err);
  }
}

async function checkChats(): Promise<void> {
  const now = Date.now();
  const warningThreshold = new Date(now - WARNING_AFTER_MS).toISOString();
  const closeThreshold = new Date(now - CLOSE_AFTER_MS).toISOString();

  // 1. Кому пора слать предупреждение (но ещё не настолько просрочено, чтобы сразу закрывать —
  // такое бывает после простоя сервера дольше 3 часов, тогда чат сразу уходит в закрытие ниже)
  const { data: toWarn, error: warnError } = await db
    .from('active_chats')
    .select('id, bot_id, client_id, master_id, updated_at, extended, bots(number)')
    .eq('status', 'active')
    .eq('warning_sent', false)
    .lte('updated_at', warningThreshold)
    .gt('updated_at', closeThreshold);

  if (warnError) {
    console.error('[AutoCloseChats] Ошибка выборки на предупреждение:', warnError.message);
  } else {
    for (const chat of (toWarn ?? []) as unknown as ChatRow[]) {
      await sendWarning(chat);
    }
  }

  // 2. Кого пора закрывать
  const { data: toClose, error: closeError } = await db
    .from('active_chats')
    .select('id, bot_id, client_id, master_id, updated_at, extended, bots(number)')
    .eq('status', 'active')
    .lte('updated_at', closeThreshold);

  if (closeError) {
    console.error('[AutoCloseChats] Ошибка выборки на закрытие:', closeError.message);
  } else {
    for (const chat of (toClose ?? []) as unknown as ChatRow[]) {
      await closeChat(chat);
    }
  }
}

export function startAutoCloseChatsJob(): void {
  setInterval(() => {
    checkChats().catch(err => console.error('[AutoCloseChats] Необработанная ошибка:', err));
  }, CHECK_INTERVAL_MS);
  console.log(`[AutoCloseChats] Джоб запущен, проверка каждые ${CHECK_INTERVAL_MS / 60000} мин`);
}
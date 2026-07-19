import { db, type BotRecord } from '../db.js';
import { getAdminBot } from '../admin/bot.js';

// ID супергруппы-сообщества (с включёнными темами). Отдельная группа от
// админской — сюда заходят мастера и клиенты, а не менеджеры.
function getCommunityChatId(): string | null {
  return process.env.COMMUNITY_CHAT_ID ?? null;
}

// Создаёт тему для конкретного города, если её ещё нет, и сохраняет
// message_thread_id в bots.community_topic_id. Идемпотентно — повторный
// вызов для города с уже созданной темой ничего не делает.
export async function ensureCommunityTopic(record: BotRecord): Promise<number | null> {
  if (record.community_topic_id) return record.community_topic_id;

  const chatId = getCommunityChatId();
  if (!chatId) {
    console.warn('[Community] COMMUNITY_CHAT_ID не задан — тема не создана.');
    return null;
  }

  const adminBot = getAdminBot();
  if (!adminBot) {
    console.warn('[Community] Admin-бот не настроен — тема не создана.');
    return null;
  }

  try {
    const topic = await adminBot.createForumTopic(chatId, record.city_name);

    const { error } = await db
      .from('bots')
      .update({ community_topic_id: topic.message_thread_id })
      .eq('id', record.id);

    if (error) {
      console.error(`[Community] Не удалось сохранить topic_id для города ${record.city_name}:`, error.message);
      return topic.message_thread_id;
    }

    console.log(`[Community] Создана тема для города ${record.city_name} (thread_id=${topic.message_thread_id})`);
    return topic.message_thread_id;
  } catch (err) {
    console.error(`[Community] Ошибка создания темы для города ${record.city_name}:`, err);
    return null;
  }
}

// Разово при старте сервера — добираем темы для городов, у которых их ещё
// нет (например, если бот был добавлен напрямую в БД, а не через админку,
// либо предыдущая попытка создания темы упала).
export async function backfillCommunityTopics(): Promise<void> {
  if (!getCommunityChatId()) return; // фича не настроена — тихо выходим

  const { data, error } = await db
    .from('bots')
    .select('id, number, token, city_name, is_active, manager_telegram_id, community_topic_id')
    .is('community_topic_id', null);

  if (error) {
    console.error('[Community] Ошибка выборки городов без темы:', error.message);
    return;
  }

  const rows = (data as BotRecord[]) ?? [];
  if (rows.length === 0) return;

  console.log(`[Community] Бэкфилл тем: городов без темы — ${rows.length}`);
  for (const record of rows) {
    await ensureCommunityTopic(record);
  }
}

// Ссылка на тему города для конкретного пользователя (кнопка в боте).
// Формат t.me/c/<internal_id>/<topic_id> — internal_id это chat_id без
// префикса -100.
export function buildCommunityTopicLink(topicId: number): string | null {
  const chatId = getCommunityChatId();
  if (!chatId) return null;

  const internalId = chatId.startsWith('-100') ? chatId.slice(4) : chatId.replace(/^-/, '');
  return `https://t.me/c/${internalId}/${topicId}`;
}

// t.me/c/... ссылки работают ТОЛЬКО для тех, кто уже состоит в группе —
// Telegram намеренно отвечает "чат не существует" всем остальным, чтобы
// не палить существование приватных чатов. Поэтому перед тем как давать
// прямую ссылку на тему, проверяем членство через getChatMember.
export async function isCommunityMember(userId: number): Promise<boolean> {
  const chatId = getCommunityChatId();
  const adminBot = getAdminBot();
  if (!chatId || !adminBot) return false;

  try {
    const member = await adminBot.getChatMember(chatId, userId);
    return member.status !== 'left' && member.status !== 'kicked';
  } catch {
    // Пользователь никогда не открывал чат с ботом / не найден — считаем,
    // что он не в группе (безопасный дефолт — ведём через инвайт-ссылку)
    return false;
  }
}

// Постоянная инвайт-ссылка на саму группу — для тех, кто ещё не вступил.
// Задаётся вручную через .env (админ создаёт её один раз в настройках
// группы: "Пригласить по ссылке"), чтобы не плодить одноразовые ссылки
// через API на каждый клик.
export function getCommunityInviteLink(): string | null {
  return process.env.COMMUNITY_INVITE_LINK ?? null;
}
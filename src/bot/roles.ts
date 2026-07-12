import { db } from '../db.js';

export async function saveRole(
  botId: number,
  telegramId: number,
  role: 'client' | 'master'
): Promise<void> {
  const { error } = await db
    .from('users')
    .upsert(
      { bot_id: botId, telegram_id: telegramId, role },
      { onConflict: 'telegram_id,bot_id' }
    );

  if (error) console.error('[saveRole] Ошибка:', error.message);
}

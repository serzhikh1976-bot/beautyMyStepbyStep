import type { TelegramBot } from 'ultra-telegram-framework';
import type { SceneContext } from 'ultra-telegram-framework';
import { db, type BotRecord } from '../db.js';
import { createBot } from './factory.js';

const cache = new Map<string, TelegramBot<SceneContext>>();

export async function getBot(uuid: string): Promise<TelegramBot<SceneContext> | null> {
  if (cache.has(uuid)) return cache.get(uuid)!;

  const { data, error } = await db
    .from('bots')
    .select('id, number, token, city_name, is_active, manager_telegram_id, community_topic_id')
    .eq('number', uuid)
    .eq('is_active', true)
    .maybeSingle();

  if (error) {
    console.error(`[BotCache] Ошибка uuid=${uuid}:`, error.message);
    return null;
  }
  if (!data) return null;

  const record = data as BotRecord;
  const bot = createBot(record);
  cache.set(uuid, bot);
  console.log(`[BotCache] Создан инстанс: ${record.city_name}`);
  return bot;
}

export function invalidateBot(uuid: string): void {
  if (cache.delete(uuid)) {
    console.log(`[BotCache] Удалён из кэша: ${uuid}`);
  }
}

export function cacheSize(): number {
  return cache.size;
}
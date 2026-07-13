import { InlineKeyboard } from 'ultra-telegram-framework';
import type { TelegramBot, SceneContext } from 'ultra-telegram-framework';
import { db, type BotRecord } from '../../db.js';
import { escapeHtml } from '../../shared/telegram-html.js';

interface ServiceRow { id: number; name: string; }
interface PriceItemRow { id: string; name: string; price: number; }

// Список услуг мастера с количеством позиций прайса в каждой
async function buildServiceListKeyboard(masterId: number, botId: number): Promise<InlineKeyboard | null> {
  const { data: masterServices } = await db
    .from('master_services')
    .select('services(id, name)')
    .eq('master_id', masterId)
    .eq('bot_id', botId);

  const services = ((masterServices as unknown as Array<{ services: ServiceRow }>) ?? [])
    .map(r => r.services)
    .filter(Boolean);

  if (services.length === 0) return null;

  const { data: items } = await db
    .from('master_price_items')
    .select('service_id')
    .eq('master_id', masterId)
    .eq('bot_id', botId);

  const counts = new Map<number, number>();
  for (const item of (items as Array<{ service_id: number }>) ?? []) {
    counts.set(item.service_id, (counts.get(item.service_id) ?? 0) + 1);
  }

  const keyboard = new InlineKeyboard();
  services.forEach((s, i) => {
    const count = counts.get(s.id) ?? 0;
    keyboard.text(`${s.name} (${count})`, `price_service:${s.id}`);
    if ((i + 1) % 2 === 0) keyboard.row();
  });
  if (services.length % 2 !== 0) keyboard.row();

  return keyboard;
}

async function showItemsForService(
  ctx: SceneContext,
  masterId: number,
  botId: number,
  serviceId: number
): Promise<void> {
  const { data: service } = await db
    .from('services')
    .select('name')
    .eq('id', serviceId)
    .maybeSingle();

  const serviceName = (service as { name: string } | null)?.name ?? 'Услуга';

  const { data: items } = await db
    .from('master_price_items')
    .select('id, name, price')
    .eq('master_id', masterId)
    .eq('bot_id', botId)
    .eq('service_id', serviceId)
    .order('created_at', { ascending: true });

  const rows = (items as PriceItemRow[]) ?? [];

  let text = `💵 <b>${escapeHtml(serviceName)}</b>\n\n`;
  text += rows.length > 0
    ? rows.map(r => `• ${escapeHtml(r.name)} — ${r.price} грн`).join('\n')
    : 'Пока нет позиций.';

  const keyboard = new InlineKeyboard();
  rows.forEach((r, i) => {
    keyboard.text(`🗑 ${r.name}`, `price_delete:${r.id}:${serviceId}`);
    if ((i + 1) % 2 === 0) keyboard.row();
  });
  if (rows.length % 2 !== 0) keyboard.row();
  keyboard.text('➕ Добавить позицию', `price_add:${serviceId}`).row();
  keyboard.text('◀️ К списку услуг', 'price_back');

  await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard.toJSON() });
}

export function registerPriceListHandlers(
  bot: TelegramBot<SceneContext>,
  record: BotRecord
): void {
  bot.match('💵 Прайс-лист', async (ctx) => {
    const masterId = ctx.message && 'from' in ctx.message ? ctx.message.from?.id : undefined;
    if (!masterId) return;

    const keyboard = await buildServiceListKeyboard(masterId, record.id);

    if (!keyboard) {
      await ctx.reply('У вас пока не выбраны услуги. Сначала добавьте их через «⚙️ Редактировать» → «🔧 Услуги».');
      return;
    }

    await ctx.reply('💵 Выберите услугу, чтобы посмотреть или изменить прайс:', {
      reply_markup: keyboard.toJSON()
    });
  });

  bot.action(/^price_service:/, async (ctx) => {
    const masterId = ctx.callbackQuery!.from.id;
    const serviceId = parseInt((ctx.callbackQuery!.data ?? '').replace('price_service:', ''));
    await ctx.answerCallbackQuery();
    await showItemsForService(ctx, masterId, record.id, serviceId);
  });

  bot.action('price_back', async (ctx) => {
    const masterId = ctx.callbackQuery!.from.id;
    await ctx.answerCallbackQuery();

    const keyboard = await buildServiceListKeyboard(masterId, record.id);
    if (!keyboard) {
      await ctx.reply('У вас пока не выбраны услуги.');
      return;
    }

    await ctx.reply('💵 Выберите услугу, чтобы посмотреть или изменить прайс:', {
      reply_markup: keyboard.toJSON()
    });
  });

bot.action(/^price_add:/, async (ctx) => {
    const serviceId = parseInt((ctx.callbackQuery!.data ?? '').replace('price_add:', ''));
    await ctx.answerCallbackQuery();
    await ctx.reply('✏️ Введите название позиции (например: Снятие геля):');
    ctx.scene.enter('add_price_item', { serviceId });
  });

  bot.action(/^price_delete:/, async (ctx) => {
    const masterId = ctx.callbackQuery!.from.id;
    const parts = (ctx.callbackQuery!.data ?? '').replace('price_delete:', '').split(':');
    const itemId = parts[0];
    const serviceId = parseInt(parts[1]);
    await ctx.answerCallbackQuery('Удалено');

    await db
      .from('master_price_items')
      .delete()
      .eq('id', itemId)
      .eq('master_id', masterId)
      .eq('bot_id', record.id);

    await showItemsForService(ctx, masterId, record.id, serviceId);
  });
}
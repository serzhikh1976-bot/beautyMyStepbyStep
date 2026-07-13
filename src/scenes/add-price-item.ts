import { WizardScene } from 'ultra-telegram-framework';
import type { SceneContext } from 'ultra-telegram-framework';
import { db } from '../db.js';

export function createAddPriceItemScene(botId: number) {
  return new WizardScene<SceneContext>(
    'add_price_item',

    // Step 0: название позиции
    async (ctx) => {
      if (!ctx.text) return;

      const name = ctx.text.trim();
      if (name.length < 2 || name.length > 100) {
        return ctx.reply('Название должно быть от 2 до 100 символов. Введите ещё раз:');
      }

      ctx.scene.state.itemName = name;
      await ctx.reply('💰 Теперь введите цену (в грн, только число):');
      ctx.scene.next();
    },

    // Step 1: цена — сохраняем позицию
    async (ctx) => {
      if (!ctx.text) return;

      const price = parseInt(ctx.text.trim());
      if (isNaN(price) || price < 0) {
        return ctx.reply('Пожалуйста, введите цену числом (например: 300):');
      }

      const telegramId = ctx.message && 'from' in ctx.message
        ? ctx.message.from?.id
        : undefined;

      if (!telegramId) return ctx.scene.leave();

      const serviceId = ctx.scene.state.serviceId as number;
      const itemName = ctx.scene.state.itemName as string;

      const { error } = await db.from('master_price_items').insert({
        master_id: telegramId,
        bot_id: botId,
        service_id: serviceId,
        name: itemName,
        price
      });

      if (error) {
        console.error('[addPriceItem] Ошибка сохранения:', error.message);
        await ctx.reply('❌ Ошибка сохранения. Попробуйте позже.');
      } else {
        await ctx.reply(`✅ Добавлено: ${itemName} — ${price} грн\n\nОткройте «💵 Прайс-лист» ещё раз, чтобы добавить следующую позицию или посмотреть список.`);
      }

      ctx.scene.leave();
    }
  );
}
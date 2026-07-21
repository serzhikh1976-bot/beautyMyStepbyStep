import {
  TelegramBot,
  NodeApiClient,
  sessionManager,
  Stage
} from 'ultra-telegram-framework';
import type { SceneContext } from 'ultra-telegram-framework';
import { type BotRecord } from '../db.js';
import { createMasterRegistrationScene } from '../scenes/master-registration.js';
import { createEditPriceScene } from '../scenes/edit-price.js';
import { createEditDistrictScene } from '../scenes/edit-district.js';
import { createEditServicesScene } from '../scenes/edit-services.js';
import { createEditPhotosScene } from '../scenes/edit-photos.js';
import { createClientSearchScene } from '../scenes/client-search.js';import { createAddPriceItemScene } from '../scenes/add-price-item.js';
import { createSupportMessageScene } from '../scenes/support-message.js';
import { createScheduleSettingsScene } from '../scenes/schedule-settings.js';
import { createEditDurationScene } from '../scenes/edit-duration.js';
import { registerStartHandlers } from './handlers/start.js';
import { registerSearchHandlers } from './handlers/search.js';
import { registerChatHandlers } from './handlers/chat.js';
import { registerProfileHandlers } from './handlers/profile.js';
import { registerPriceListHandlers } from './handlers/price-list.js';
import { registerSupportHandlers } from './handlers/support.js';
import { registerRoleSwitchHandlers } from './handlers/role-switch.js';
import { registerCommunityHandlers } from './handlers/community.js';
import { registerScheduleHandlers } from './handlers/schedule.js';
import { registerBookingHandlers } from './handlers/booking.js';
import { registerMyAppointmentsHandlers } from './handlers/my-appointments.js';

export function createBot(record: BotRecord): TelegramBot<SceneContext> {
  const bot = new TelegramBot<SceneContext>(new NodeApiClient(record.token));

  bot.catch((err) => {
    console.error(`[${record.city_name}] Ошибка:`, err);
  });

  // Сессии с правильным ключом (обходим баг ctx.from в UTF)
  bot.use(sessionManager({
    initial: () => ({}),
    getSessionKey: (ctx) => {
      const userId = ctx.callbackQuery?.from.id ??
        (ctx.message && 'from' in ctx.message ? ctx.message.from?.id : undefined);
      const chatId = ctx.chatId;
      if (!userId || !chatId) return undefined;
      return `${record.id}:${chatId}:${userId}`;
    }
  }));

 bot.use(async (ctx, next) => {
    const text = ctx.message && 'text' in ctx.message ? ctx.message.text : undefined;
    const escapeTriggers = ['/start', '🔄 Сменить роль', '📅 Календарь', '📅 Мои записи'];
    if (text && escapeTriggers.includes(text) && ctx.session && '__scene' in ctx.session) {
      delete ctx.session.__scene;
    }
    return next();
  });

  // Сцены
// Сцены
  const stage = new Stage<SceneContext>([
    createMasterRegistrationScene(record.id),
    createEditPriceScene(record.id),
    createEditDistrictScene(record.id),
    createEditServicesScene(record.id),
    createEditPhotosScene(record.id),
createClientSearchScene(record.id),
    createAddPriceItemScene(record.id),
    createSupportMessageScene(record.id),
    createScheduleSettingsScene(record.id),
    createEditDurationScene(record.id)
  ]);
  bot.use(stage.middleware());

  registerStartHandlers(bot, record);
  registerSearchHandlers(bot, record);
  registerProfileHandlers(bot, record); // до chat — чтобы bot.match('👤 Мой профиль') не перехватывался bot.on('text')
  registerPriceListHandlers(bot, record); // тоже до chat — та же причина, bot.match('💵 Прайс-лист')
  registerSupportHandlers(bot, record); // тоже до chat — bot.match('🆘 Поддержка')
  registerRoleSwitchHandlers(bot, record); // тоже до chat — bot.match('🔄 Сменить роль')
  registerCommunityHandlers(bot, record); // тоже до chat — bot.match('👥 Сообщество')
  registerScheduleHandlers(bot, record); // тоже до chat — bot.match('📅 Календарь')
  registerBookingHandlers(bot, record); // это all bot.action(), порядок относительно chat не важен
  registerMyAppointmentsHandlers(bot, record); // до chat — bot.match('📅 Мои записи')
  registerChatHandlers(bot, record);

  return bot;
}
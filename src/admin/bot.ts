import {
  TelegramBot,
  NodeApiClient,
  InlineKeyboard,
  Context
} from 'ultra-telegram-framework';
import { db } from '../db.js';
import { escapeHtml } from '../shared/telegram-html.js';
import { getBot } from '../bot/index.js';

interface AdminContext extends Context {
  isSuperAdmin?: boolean;
  managedCities?: Array<{ id: number; city_name: string }>;
}

// ── Singleton ────────────────────────────────────────────────────────────
// В отличие от city-ботов (bot-manager.ts), этот бот не в таблице `bots` —
// он один на всю систему, конфиг только через .env.

let adminBot: TelegramBot<AdminContext> | null = null;
let warnedMissingConfig = false;

export function getAdminBotUuid(): string | null {
  return process.env.ADMIN_BOT_UUID ?? null;
}

export function getAdminBot(): TelegramBot<AdminContext> | null {
  const token = process.env.ADMIN_BOT_TOKEN;
  const superAdminId = process.env.SUPER_ADMIN_ID;

  if (!token || !superAdminId) {
    if (!warnedMissingConfig) {
      console.warn('[AdminBot] ADMIN_BOT_TOKEN / SUPER_ADMIN_ID не заданы — админ-бот отключён.');
      warnedMissingConfig = true;
    }
    return null;
  }

  if (adminBot) return adminBot;

  adminBot = createAdminBot(token, Number(superAdminId));
  console.log('[AdminBot] Инстанс создан.');
  return adminBot;
}

// ── Бот ──────────────────────────────────────────────────────────────────

function createAdminBot(token: string, superAdminId: number): TelegramBot<AdminContext> {
  const bot = new TelegramBot<AdminContext>(new NodeApiClient(token));

  bot.catch((err) => {
    console.error('[AdminBot] Ошибка:', err);
  });

  // Пускаем суперадмина (полный доступ к дашборду) и менеджеров городов
  // (только для ответов в поддержку — их manager_telegram_id должен быть
  // прописан хотя бы у одного города в таблице bots). Всех остальных
  // молча игнорируем.
  bot.use(async (ctx, next) => {
    const userId = ctx.callbackQuery?.from.id
      ?? (ctx.message && 'from' in ctx.message ? ctx.message.from?.id : undefined);

    if (!userId) return;

    if (userId === superAdminId) {
      ctx.isSuperAdmin = true;
      await next();
      return;
    }

    const { data } = await db
      .from('bots')
      .select('id, city_name')
      .eq('manager_telegram_id', userId);

    const managedCities = (data as Array<{ id: number; city_name: string }>) ?? [];
    if (managedCities.length === 0) return; // не суперадмин и не менеджер — игнор

    ctx.isSuperAdmin = false;
    ctx.managedCities = managedCities;
    await next();
  });

  bot.command('start', async (ctx) => {
    if (ctx.isSuperAdmin) {
      await sendDashboard(ctx);
    } else {
      const cities = ctx.managedCities?.map((c) => c.city_name).join(', ') ?? '';
      await ctx.reply(
        `👋 Вы менеджер по городам: <b>${escapeHtml(cities)}</b>.\n\n` +
          `Сюда будут приходить сообщения от мастеров в поддержку — просто отвечайте Reply на них, чтобы ответить мастеру.`,
        { parse_mode: 'HTML' }
      );
    }
  });

  bot.action('admin_dashboard', async (ctx) => {
    await ctx.answerCallbackQuery();
    if (ctx.isSuperAdmin) await sendDashboard(ctx);
  });

  bot.action(/^admin_city:/, async (ctx) => {
    if (!ctx.isSuperAdmin) return;
    const botId = parseInt((ctx.callbackQuery!.data ?? '').replace('admin_city:', ''));
    await ctx.answerCallbackQuery();
    await sendCityDetails(ctx, botId);
  });

  bot.action('admin_chats', async (ctx) => {
    if (!ctx.isSuperAdmin) return;
    await ctx.answerCallbackQuery();
    await sendActiveChats(ctx);
  });

  // Ответ менеджера/суперадмина мастеру — по Reply на сообщение поддержки
  bot.on('text', async (ctx) => {
    const msg = ctx.message as unknown as Record<string, unknown>;
    const replyToId = (msg?.reply_to_message as Record<string, unknown> | undefined)
      ?.message_id as number | undefined;

    if (!replyToId) return;

const { data: supportMsg } = await db
      .from('support_messages')
      .select('id, bot_id, master_id')
      .eq('admin_message_id', replyToId)
      .maybeSingle();

    if (!supportMsg) return;

    const raw = supportMsg as { id: number; bot_id: number; master_id: number };

    // Менеджер может отвечать только за свои города (суперадмин — за любые)
    if (!ctx.isSuperAdmin && !ctx.managedCities?.some((c) => c.id === raw.bot_id)) {
      await ctx.reply('⚠️ Это сообщение не из вашего города.');
      return;
    }

    const { data: botRow } = await db
      .from('bots')
      .select('number')
      .eq('id', raw.bot_id)
      .maybeSingle();

    const uuid = (botRow as { number: string } | null)?.number;
    if (!uuid) return;

    const cityBot = await getBot(uuid);
    if (!cityBot) {
      await ctx.reply('⚠️ Не удалось найти бота этого города.');
      return;
    }

    try {
      await cityBot.sendMessage(
        raw.master_id,
        `💬 <b>Ответ от поддержки:</b>\n\n${escapeHtml(ctx.text ?? '')}`,
        { parse_mode: 'HTML' }
      );

      const replierId = ctx.callbackQuery?.from.id
        ?? (ctx.message && 'from' in ctx.message ? ctx.message.from?.id : undefined);

      await db.from('support_replies').insert({
        support_message_id: raw.id,
        reply_text: ctx.text ?? '',
        admin_telegram_id: replierId ?? 0
      });

      await ctx.reply('✅ Отправлено мастеру.');
    } catch (err) {
      console.error('[AdminBot] Ошибка отправки ответа мастеру:', err);
      await ctx.reply('❌ Не удалось отправить — мастер мог заблокировать бота.');
    }
  });

  return bot;
}

// ── Дашборд: сводка по всем городам ────────────────────────────────────

async function sendDashboard(ctx: AdminContext): Promise<void> {
  const { data: botsRaw, error: botsError } = await db
    .from('bots')
    .select('id, city_name, is_active')
    .order('city_name');

  if (botsError) {
    console.error('[AdminBot] Ошибка загрузки bots:', botsError.message);
    await ctx.reply('⚠️ Не удалось загрузить данные. Попробуйте позже.');
    return;
  }

  const cities = (botsRaw as Array<{ id: number; city_name: string; is_active: boolean }>) ?? [];

  if (cities.length === 0) {
    await ctx.reply('Городов пока нет в системе.');
    return;
  }

  const botIds = cities.map((c) => c.id);

  const [{ data: mastersRaw }, { data: chatsRaw }] = await Promise.all([
    db.from('masters_profiles').select('bot_id, is_active').in('bot_id', botIds),
    db.from('active_chats').select('bot_id').eq('status', 'active').in('bot_id', botIds)
  ]);

  const masters = (mastersRaw as Array<{ bot_id: number; is_active: boolean }>) ?? [];
  const chats = (chatsRaw as Array<{ bot_id: number }>) ?? [];

  const mastersByBot = new Map<number, { total: number; active: number }>();
  for (const m of masters) {
    const stat = mastersByBot.get(m.bot_id) ?? { total: 0, active: 0 };
    stat.total += 1;
    if (m.is_active) stat.active += 1;
    mastersByBot.set(m.bot_id, stat);
  }

  const chatsByBot = new Map<number, number>();
  for (const c of chats) {
    chatsByBot.set(c.bot_id, (chatsByBot.get(c.bot_id) ?? 0) + 1);
  }

  const activeCities = cities.filter((c) => c.is_active).length;

  const text =
    `🛠 <b>Панель суперадмина</b>\n\n` +
    `🏙 Городов: ${cities.length} (активно: ${activeCities})\n` +
    `💼 Мастеров всего: ${masters.length} (активно: ${masters.filter((m) => m.is_active).length})\n` +
    `💬 Открытых чатов: ${chats.length}\n\n` +
    `Выберите город для деталей:`;

  const keyboard = new InlineKeyboard();
  for (const city of cities) {
    const stat = mastersByBot.get(city.id) ?? { total: 0, active: 0 };
    const chatCount = chatsByBot.get(city.id) ?? 0;
    const statusIcon = city.is_active ? '🟢' : '🔴';

    keyboard
      .text(
        `${statusIcon} ${city.city_name} · 👤${stat.active}/${stat.total} · 💬${chatCount}`,
        `admin_city:${city.id}`
      )
      .row();
  }
  keyboard.text('💬 Все активные чаты', 'admin_chats');

  await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard.toJSON() });
}

// ── Детали по одному городу ─────────────────────────────────────────────

async function sendCityDetails(ctx: AdminContext, botId: number): Promise<void> {
  const { data: cityRaw } = await db
    .from('bots')
    .select('city_name, is_active')
    .eq('id', botId)
    .maybeSingle();

  if (!cityRaw) {
    await ctx.reply('Город не найден.');
    return;
  }

  const city = cityRaw as { city_name: string; is_active: boolean };

  const [{ data: mastersRaw }, { data: chatsRaw }] = await Promise.all([
    db
      .from('masters_profiles')
      .select('name, is_active, price_from')
      .eq('bot_id', botId)
      .order('is_active', { ascending: false }),
    db.from('active_chats').select('id').eq('bot_id', botId).eq('status', 'active')
  ]);

  const masters = (mastersRaw as Array<{ name: string; is_active: boolean; price_from: number }>) ?? [];
  const chatCount = ((chatsRaw as unknown[]) ?? []).length;

  let text =
    `${city.is_active ? '🟢' : '🔴'} <b>${escapeHtml(city.city_name)}</b>\n` +
    `💬 Открытых чатов: ${chatCount}\n\n` +
    `<b>Мастера (${masters.length}):</b>\n`;

  if (masters.length === 0) {
    text += '—\n';
  } else {
    for (const m of masters) {
      text += `${m.is_active ? '✅' : '⏸'} ${escapeHtml(m.name)} · от ${m.price_from} грн\n`;
    }
  }

  const keyboard = new InlineKeyboard().text('⬅️ Назад', 'admin_dashboard');

  await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard.toJSON() });
}

// ── Все активные чаты по всем городам ───────────────────────────────────

async function sendActiveChats(ctx: AdminContext): Promise<void> {
  const { data: chatsRaw } = await db
    .from('active_chats')
    .select('client_id, master_id, updated_at, bots(city_name)')
    .eq('status', 'active')
    .order('updated_at', { ascending: false });

  const chats = (chatsRaw as Array<Record<string, unknown>>) ?? [];

  const keyboard = new InlineKeyboard().text('⬅️ Назад', 'admin_dashboard');

  if (chats.length === 0) {
    await ctx.reply('Активных чатов нет.', { reply_markup: keyboard.toJSON() });
    return;
  }

  let text = `💬 <b>Активные чаты (${chats.length}):</b>\n\n`;
  for (const chat of chats) {
    const cityName = (chat.bots as { city_name: string } | null)?.city_name ?? '—';
    const updatedAt = new Date(chat.updated_at as string);
    const minutesAgo = Math.max(0, Math.round((Date.now() - updatedAt.getTime()) / 60000));

    text += `🏙 ${escapeHtml(cityName)} · клиент <code>${chat.client_id}</code> ↔ мастер <code>${chat.master_id}</code> · ${minutesAgo} мин назад\n`;
  }

  await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard.toJSON() });
}
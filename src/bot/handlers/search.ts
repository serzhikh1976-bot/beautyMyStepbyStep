import { InlineKeyboard } from 'ultra-telegram-framework';
import type { TelegramBot, SceneContext } from 'ultra-telegram-framework';
import { db, type BotRecord } from '../../db.js';
import { escapeHtml } from '../../shared/telegram-html.js';
import { clearButtons } from '../helpers.js';
import { getServicesWithMasters } from '../../scenes/client-search.js';

export function registerSearchHandlers(
  bot: TelegramBot<SceneContext>,
  record: BotRecord
): void {
  // Поиск мастеров (кнопка и команда)
  const startSearch = async (ctx: SceneContext) => {
    const userId = ctx.from?.id;

    // Если уже есть открытый чат — сразу говорим об этом, не гоняя клиента
    // через весь визард поиска чтобы упереться в этот же экран в конце
    if (userId) {
      const { data: existing, error: existingError } = await db
        .from('active_chats')
        .select('master_id')
        .eq('client_id', userId)
        .eq('bot_id', record.id)
        .eq('status', 'active')
        .maybeSingle();

      if (existingError) {
        console.error(`[${record.city_name}] Ошибка проверки активного чата:`, existingError.message);
      }

      if (existing) {
        const masterId = (existing as { master_id: number }).master_id;

        const { data: masterProfile } = await db
          .from('masters_profiles')
          .select('name')
          .eq('master_id', masterId)
          .eq('bot_id', record.id)
          .maybeSingle();

        const masterName = (masterProfile as { name: string } | null)?.name ?? 'мастером';

        return ctx.reply(
          `У вас уже открыт чат с <b>${escapeHtml(masterName)}</b>.\n\nСначала завершите его, потом сможете найти другого мастера.`,
          { parse_mode: 'HTML' }
        );
      }
    }

    const services = await getServicesWithMasters(record.id);

    if (services.length === 0) {
      return ctx.reply('😔 Пока нет доступных мастеров. Загляните позже!');
    }

    const keyboard = new InlineKeyboard();
    const PER_ROW = 2;
    services.forEach((s, i) => {
      keyboard.text(s.name, `search_svc:${s.id}`);
      if ((i + 1) % PER_ROW === 0) keyboard.row();
    });
    if (services.length % PER_ROW !== 0) keyboard.row();

    await ctx.reply(
      '🔧 Какая услуга вам нужна?',
      { reply_markup: keyboard.toJSON() }
    );

    ctx.scene.enter('client_search');
    ctx.scene.state.services_list = services;
  };

  bot.match('🔍 Найти мастера', startSearch);
  bot.command('search', startSearch);

  // Полная карточка мастера для клиента
  bot.action(/^master_card:/, async (ctx) => {
    const masterId = parseInt((ctx.callbackQuery!.data ?? '').replace('master_card:', ''));
    await ctx.answerCallbackQuery();
    await clearButtons(bot, ctx);

    const { data } = await db
      .from('masters_profiles')
      .select(`
        name, price_from, photos,
        districts(name),
        sub_districts(name),
        master_services(services(name))
      `)
      .eq('master_id', masterId)
      .eq('bot_id', record.id)
      .maybeSingle();

    if (!data) return ctx.reply('Профиль не найден.');

    const raw = data as Record<string, unknown>;
    const districtName = (raw.districts as { name: string } | null)?.name ?? '';
    const subDistrictName = (raw.sub_districts as { name: string } | null)?.name ?? '';
    const location = subDistrictName
      ? `${districtName} → ${subDistrictName}`
      : districtName || '—';

    const services = (raw.master_services as Array<{ services: { name: string } }> ?? [])
      .map(ms => ms.services?.name)
      .filter(Boolean)
      .join(', ') || '—';

    const text =
      `👤 <b>${escapeHtml(raw.name as string)}</b>\n` +
      `💼 ${escapeHtml(services)}\n` +
      `📍 ${escapeHtml(location)}\n` +
      `💰 от ${raw.price_from} грн`;

    const keyboard = new InlineKeyboard()
      .text('💬 Написать мастеру', `chat:${masterId}`)
      .text('💰 Смотреть цены', `price_view:${masterId}`);

    const photos = raw.photos as string[];

    if (photos && photos.length > 0) {
      try {
        await ctx.replyWithMediaGroup(
          photos.map((fileId: string, i: number) => ({
            type: 'photo' as const,
            media: fileId,
            ...(i === 0 ? { caption: text, parse_mode: 'HTML' as const } : {})
          }))
        );
        await ctx.reply('👆 Контакт мастера:', { reply_markup: keyboard.toJSON() });
      } catch {
        // fileId устарел — показываем карточку без фото
        await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard.toJSON() });
      }
    } else {
      await ctx.reply(text, {
        parse_mode: 'HTML',
        reply_markup: keyboard.toJSON()
      });
    }
  });

  // Просмотр детального прайс-листа мастера клиентом
  bot.action(/^price_view:/, async (ctx) => {
    const masterId = parseInt((ctx.callbackQuery!.data ?? '').replace('price_view:', ''));
    await ctx.answerCallbackQuery();

    const { data: items, error } = await db
      .from('master_price_items')
      .select('name, price, service_id')
      .eq('master_id', masterId)
      .eq('bot_id', record.id)
      .order('service_id', { ascending: true })
      .order('created_at', { ascending: true });

    if (error) {
      console.error(`[${record.city_name}] price_view: ошибка выборки:`, error.message);
    }

    const rows = (items as Array<{ name: string; price: number; service_id: number }>) ?? [];

    if (rows.length === 0) {
      await ctx.reply('Мастер пока не указал детальный прайс. Актуальную цену уточняйте в чате.');
      return;
    }

    // Имена услуг подтягиваем отдельным запросом — без опоры на PostgREST-embed,
    // который требует объявленного foreign key между таблицами
    const serviceIds = [...new Set(rows.map(r => r.service_id))];
    const { data: services } = await db
      .from('services')
      .select('id, name')
      .in('id', serviceIds);

    const serviceNames = new Map<number, string>();
    for (const s of (services as Array<{ id: number; name: string }>) ?? []) {
      serviceNames.set(s.id, s.name);
    }

    // Группируем по названию услуги, сохраняя порядок первого появления
    const grouped = new Map<string, string[]>();
    for (const row of rows) {
      const serviceName = serviceNames.get(row.service_id) ?? 'Прочее';
      if (!grouped.has(serviceName)) grouped.set(serviceName, []);
      grouped.get(serviceName)!.push(`• ${escapeHtml(row.name)} — ${row.price} грн`);
    }

    let text = '💵 <b>Прайс-лист</b>\n\n';
    for (const [serviceName, lines] of grouped) {
      text += `<b>${escapeHtml(serviceName)}</b>\n${lines.join('\n')}\n\n`;
    }

    const keyboard = new InlineKeyboard()
      .text('💬 Написать мастеру', `chat:${masterId}`);

    await ctx.reply(text.trim(), { parse_mode: 'HTML', reply_markup: keyboard.toJSON() });
  });
}
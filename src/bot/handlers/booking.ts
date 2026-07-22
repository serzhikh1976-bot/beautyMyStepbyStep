import { InlineKeyboard } from 'ultra-telegram-framework';
import type { TelegramBot, SceneContext } from 'ultra-telegram-framework';
import { db, type BotRecord } from '../../db.js';
import { escapeHtml } from '../../shared/telegram-html.js';
import { clearButtons } from '../helpers.js';

// Упрощение: фиксированный оффсет UTC+3 (лето по Киеву), без библиотеки
// часовых поясов. Не подстраивается под переход на зимнее время — для
// пилота приемлемо, см. обсуждение в чате.
const TZ_OFFSET = '+03:00';

const DAY_LABELS_SHORT: Record<number, string> = {
  1: 'Пн', 2: 'Вт', 3: 'Ср', 4: 'Чт', 5: 'Пт', 6: 'Сб', 7: 'Вс'
};

const SLOT_STEP_MINUTES = 30; // шаг сетки кандидатов на старт слота
const DAYS_AHEAD = 14; // на сколько дней вперёд ищем рабочие дни
const MIN_LEAD_MINUTES = 30; // нельзя записаться раньше чем через 30 минут от текущего момента

interface ScheduleSettings {
  working_days: number[];
  start_time: string; // "09:00:00"
  end_time: string;
}

interface Appointment {
  slot_start: string;
  slot_end: string;
}

// callback_data вида "book_time:12345:6:2026-07-21T09:00:00.000Z" — сама
// ISO-дата содержит двоеточия, поэтому наивный split(':') её бы развалил.
// Берём первые 3 части как есть, а всё остальное склеиваем обратно.
function splitBookingData(data: string): [string, string, string, string] {
  const parts = data.split(':');
  return [parts[0], parts[1], parts[2], parts.slice(3).join(':')];
}

// Локальная дата (Киев) в формате YYYY-MM-DD со сдвигом в daysOffset дней от сегодня
function localDateString(daysOffset: number): string {
  const now = new Date(Date.now() + 3 * 60 * 60 * 1000); // сдвигаем на +3ч, чтобы getUTC* дали киевское время
  now.setUTCDate(now.getUTCDate() + daysOffset);
  return now.toISOString().slice(0, 10);
}

// ISO weekday (1=Пн..7=Вс) для даты YYYY-MM-DD по киевскому времени
function isoWeekday(dateStr: string): number {
  const d = new Date(`${dateStr}T12:00:00${TZ_OFFSET}`); // полдень — чтобы не зацепить сдвиг суток
  const day = d.getUTCDay(); // 0=Вс..6=Сб
  return day === 0 ? 7 : day;
}

function toUtcDate(dateStr: string, time: string): Date {
  return new Date(`${dateStr}T${time}${TZ_OFFSET}`);
}

function formatDateLabel(dateStr: string): string {
  const [, m, d] = dateStr.split('-');
  const weekday = DAY_LABELS_SHORT[isoWeekday(dateStr)];
  return `${weekday} ${d}.${m}`;
}

function formatTimeLabel(date: Date): string {
  // Смещаем на +3ч и берём UTC-часы/минуты — получаем киевское время без библиотек
  const kyiv = new Date(date.getTime() + 3 * 60 * 60 * 1000);
  const hh = String(kyiv.getUTCHours()).padStart(2, '0');
  const mm = String(kyiv.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

// Свободные слоты на конкретную дату для конкретной услуги
async function computeAvailableSlots(
  botId: number,
  masterId: number,
  dateStr: string,
  durationMinutes: number,
  settings: ScheduleSettings
): Promise<Date[]> {
  const dayStart = toUtcDate(dateStr, settings.start_time.slice(0, 5));
  const dayEnd = toUtcDate(dateStr, settings.end_time.slice(0, 5));

  const { data } = await db
    .from('appointments')
    .select('slot_start, slot_end')
    .eq('bot_id', botId)
    .eq('master_id', masterId)
    .eq('status', 'confirmed')
    .gte('slot_start', dayStart.toISOString())
    .lt('slot_start', new Date(dayStart.getTime() + 24 * 60 * 60 * 1000).toISOString());

  const booked = (data as Appointment[]) ?? [];
  const durationMs = durationMinutes * 60 * 1000;
  const stepMs = SLOT_STEP_MINUTES * 60 * 1000;
  const earliestAllowed = Date.now() + MIN_LEAD_MINUTES * 60 * 1000;

  const slots: Date[] = [];
  for (let t = dayStart.getTime(); t + durationMs <= dayEnd.getTime(); t += stepMs) {
    if (t < earliestAllowed) continue;

    const slotStart = t;
    const slotEnd = t + durationMs;

    const overlaps = booked.some((b) => {
      const bStart = new Date(b.slot_start).getTime();
      const bEnd = new Date(b.slot_end).getTime();
      return slotStart < bEnd && slotEnd > bStart;
    });

    if (!overlaps) slots.push(new Date(slotStart));
  }

  return slots;
}

export function registerBookingHandlers(
  bot: TelegramBot<SceneContext>,
  record: BotRecord
): void {
  // Шаг 1: выбор услуги
  bot.action(/^book:/, async (ctx) => {
    const masterId = parseInt((ctx.callbackQuery!.data ?? '').replace('book:', ''));
    await ctx.answerCallbackQuery();

    const { data: masterProfile } = await db
      .from('masters_profiles')
      .select('is_active')
      .eq('master_id', masterId)
      .eq('bot_id', record.id)
      .maybeSingle();

    if (!masterProfile || !(masterProfile as { is_active: boolean }).is_active) {
      await ctx.reply('Мастер сейчас не принимает новых клиентов.');
      return;
    }

    const { data: settings } = await db
      .from('master_schedule_settings')
      .select('working_days')
      .eq('master_id', masterId)
      .eq('bot_id', record.id)
      .maybeSingle();

    if (!settings) {
      await ctx.reply('Мастер ещё не настроил расписание записи. Можете написать ему в чат напрямую.');
      return;
    }

    const { data: services } = await db
      .from('master_services')
      .select('service_id, duration_minutes, services(name)')
      .eq('master_id', masterId)
      .eq('bot_id', record.id);

    const rows = (services as unknown as Array<{ service_id: number; duration_minutes: number; services: { name: string } | null }>) ?? [];

    if (rows.length === 0) {
      await ctx.reply('У мастера пока не указаны услуги для записи.');
      return;
    }

    const keyboard = new InlineKeyboard();
    rows.forEach((r, i) => {
      const name = r.services?.name ?? 'Услуга';
      keyboard.text(`${name} (${r.duration_minutes} мин)`, `book_svc:${masterId}:${r.service_id}`);
      if ((i + 1) % 2 === 0) keyboard.row();
    });
    if (rows.length % 2 !== 0) keyboard.row();

    await ctx.reply('📅 Выберите услугу:', { reply_markup: keyboard.toJSON() });
  });

  // Шаг 2: выбор даты
  bot.action(/^book_svc:/, async (ctx) => {
    const [, masterIdStr, serviceIdStr] = splitBookingData(ctx.callbackQuery!.data ?? '');
    const masterId = parseInt(masterIdStr);
    const serviceId = parseInt(serviceIdStr);
    await ctx.answerCallbackQuery();

    const { data: settings } = await db
      .from('master_schedule_settings')
      .select('working_days, start_time, end_time')
      .eq('master_id', masterId)
      .eq('bot_id', record.id)
      .maybeSingle();

    const sched = settings as ScheduleSettings | null;
    if (!sched) {
      await ctx.reply('Мастер ещё не настроил расписание записи.');
      return;
    }

    const keyboard = new InlineKeyboard();
    let count = 0;
    for (let i = 0; i < DAYS_AHEAD; i++) {
      const dateStr = localDateString(i);
      if (!sched.working_days.includes(isoWeekday(dateStr))) continue;

      keyboard.text(formatDateLabel(dateStr), `book_date:${masterId}:${serviceId}:${dateStr}`);
      count++;
      if (count % 3 === 0) keyboard.row();
    }
    if (count % 3 !== 0) keyboard.row();

    if (count === 0) {
      await ctx.reply('У мастера нет рабочих дней в ближайшие 2 недели.');
      return;
    }

    await ctx.reply('📅 Выберите дату:', { reply_markup: keyboard.toJSON() });
  });

  // Шаг 3: выбор времени
  bot.action(/^book_date:/, async (ctx) => {
    const [, masterIdStr, serviceIdStr, dateStr] = splitBookingData(ctx.callbackQuery!.data ?? '');
    const masterId = parseInt(masterIdStr);
    const serviceId = parseInt(serviceIdStr);
    await ctx.answerCallbackQuery();

    const [{ data: settings }, { data: serviceRow }] = await Promise.all([
      db.from('master_schedule_settings').select('working_days, start_time, end_time').eq('master_id', masterId).eq('bot_id', record.id).maybeSingle(),
      db.from('master_services').select('duration_minutes').eq('master_id', masterId).eq('bot_id', record.id).eq('service_id', serviceId).maybeSingle()
    ]);

    const sched = settings as ScheduleSettings | null;
    const duration = (serviceRow as { duration_minutes: number } | null)?.duration_minutes;

    if (!sched || !duration) {
      await ctx.reply('⚠️ Не удалось загрузить расписание. Попробуйте ещё раз.');
      return;
    }

    const slots = await computeAvailableSlots(record.id, masterId, dateStr, duration, sched);

    if (slots.length === 0) {
      await ctx.reply('На эту дату свободных слотов нет. Выберите другую дату через «📅 Записаться».');
      return;
    }

    const keyboard = new InlineKeyboard();
    slots.forEach((slot, i) => {
      keyboard.text(formatTimeLabel(slot), `book_time:${masterId}:${serviceId}:${slot.toISOString()}`);
      if ((i + 1) % 4 === 0) keyboard.row();
    });
    if (slots.length % 4 !== 0) keyboard.row();

    await ctx.reply(`🕐 Свободное время на ${formatDateLabel(dateStr)}:`, { reply_markup: keyboard.toJSON() });
  });

  // Шаг 4: подтверждение
  bot.action(/^book_time:/, async (ctx) => {
    const [, masterIdStr, serviceIdStr, isoStr] = splitBookingData(ctx.callbackQuery!.data ?? '');
    await ctx.answerCallbackQuery();

    const masterId = parseInt(masterIdStr);
    const serviceId = parseInt(serviceIdStr);

    const { data: serviceRow } = await db
      .from('master_services')
      .select('duration_minutes, services(name)')
      .eq('master_id', masterId)
      .eq('bot_id', record.id)
      .eq('service_id', serviceId)
      .maybeSingle();

    const svc = serviceRow as unknown as { duration_minutes: number; services: { name: string } | null } | null;
    if (!svc) {
      await ctx.reply('⚠️ Услуга не найдена.');
      return;
    }

    const slotStart = new Date(isoStr);
    const dateStr = new Date(slotStart.getTime() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const keyboard = new InlineKeyboard()
      .text('✅ Подтвердить', `book_confirm:${masterId}:${serviceId}:${isoStr}`)
      .text('Отмена', 'book_cancel');

    await ctx.reply(
      `📅 <b>Подтверждение записи</b>\n\n` +
        `Услуга: ${escapeHtml(svc.services?.name ?? '—')} (${svc.duration_minutes} мин)\n` +
        `Дата: ${formatDateLabel(dateStr)}\n` +
        `Время: ${formatTimeLabel(slotStart)}`,
      { parse_mode: 'HTML', reply_markup: keyboard.toJSON() }
    );
  });

  bot.action('book_cancel', async (ctx) => {
    await ctx.answerCallbackQuery('Отменено');
    await clearButtons(bot, ctx);
  });

  // Шаг 5: финальное создание записи (с повторной проверкой на гонку)
  bot.action(/^book_confirm:/, async (ctx) => {
    const [, masterIdStr, serviceIdStr, isoStr] = splitBookingData(ctx.callbackQuery!.data ?? '');
    const masterId = parseInt(masterIdStr);
    const serviceId = parseInt(serviceIdStr);
    const clientId = ctx.callbackQuery!.from.id;

    await ctx.answerCallbackQuery();
    await clearButtons(bot, ctx);

    const { data: serviceRow } = await db
      .from('master_services')
      .select('duration_minutes, services(name)')
      .eq('master_id', masterId)
      .eq('bot_id', record.id)
      .eq('service_id', serviceId)
      .maybeSingle();

    const svc = serviceRow as unknown as { duration_minutes: number; services: { name: string } | null } | null;
    if (!svc) {
      await ctx.reply('⚠️ Услуга не найдена.');
      return;
    }

    const slotStart = new Date(isoStr);
    const slotEnd = new Date(slotStart.getTime() + svc.duration_minutes * 60 * 1000);

    // Перепроверяем lead-time на случай если клиент завис на экране
    // подтверждения — слот мог "протухнуть" (стать слишком близким к
    // текущему моменту или вовсе уйти в прошлое) пока он думал
    if (slotStart.getTime() < Date.now() + MIN_LEAD_MINUTES * 60 * 1000) {
      await ctx.reply('😔 Это время уже прошло или почти наступило. Выберите другое через «📅 Записаться».');
      return;
    }

    // Повторно проверяем пересечение прямо перед вставкой — на случай если
    // кто-то другой забронировал этот же слот, пока клиент думал над подтверждением
    const { data: clashing } = await db
      .from('appointments')
      .select('id')
      .eq('bot_id', record.id)
      .eq('master_id', masterId)
      .eq('status', 'confirmed')
      .lt('slot_start', slotEnd.toISOString())
      .gt('slot_end', slotStart.toISOString());

    if (clashing && clashing.length > 0) {
      await ctx.reply('😔 Это время уже заняли. Выберите другое через «📅 Записаться».');
      return;
    }

    const { error } = await db.from('appointments').insert({
      bot_id: record.id,
      master_id: masterId,
      client_id: clientId,
      service_id: serviceId,
      slot_start: slotStart.toISOString(),
      slot_end: slotEnd.toISOString()
    });

    if (error) {
      console.error(`[${record.city_name}] Ошибка создания записи:`, error.message);
      if (error.code === '23P01') {
        // exclusion_violation от констрейнта appointments_no_overlap —
        // кто-то другой успел забронировать этот же слот буквально в момент вставки
        await ctx.reply('😔 Это время уже заняли. Выберите другое через «📅 Записаться».');
      } else {
        await ctx.reply('❌ Не удалось создать запись. Попробуйте позже.');
      }
      return;
    }

    const dateStr = new Date(slotStart.getTime() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const serviceName = svc.services?.name ?? '—';

    await ctx.reply(
      `✅ Вы записаны!\n\n${escapeHtml(serviceName)}\n${formatDateLabel(dateStr)} в ${formatTimeLabel(slotStart)}`
    );

    try {
      let clientName = 'Клиент';
      try {
        const clientChat = await bot.getChat(clientId);
        if (clientChat.first_name) clientName = clientChat.first_name;
      } catch {
        // не критично
      }

      await bot.sendMessage(
        masterId,
        `📅 <b>Новая запись!</b>\n\n` +
          `Клиент: ${escapeHtml(clientName)}\n` +
          `Услуга: ${escapeHtml(serviceName)}\n` +
          `${formatDateLabel(dateStr)} в ${formatTimeLabel(slotStart)}`,
        { parse_mode: 'HTML' }
      );
    } catch (err) {
      console.error(`[${record.city_name}] Ошибка уведомления мастера о записи:`, err);
    }
  });

  // Отмена записи — общий хендлер для клиента и мастера. Кто именно нажал,
  // определяем по совпадению telegram id с client_id/master_id самой записи,
  // и уведомляем противоположную сторону.
  bot.action(/^appt_cancel:/, async (ctx) => {
    const id = (ctx.callbackQuery!.data ?? '').replace('appt_cancel:', '');
    await ctx.answerCallbackQuery();
    await clearButtons(bot, ctx);

    const userId = ctx.callbackQuery!.from.id;

    const { data } = await db
      .from('appointments')
      .select('id, master_id, client_id, slot_start, status, services(name)')
      .eq('id', id)
      .eq('bot_id', record.id)
      .maybeSingle();

    const appt = data as unknown as {
      id: string; master_id: number; client_id: number; slot_start: string;
      status: string; services: { name: string } | null;
    } | null;

    if (!appt || appt.status !== 'confirmed') {
      await ctx.reply('Эта запись уже не активна.');
      return;
    }
    if (appt.client_id !== userId && appt.master_id !== userId) {
      await ctx.reply('Запись не найдена.');
      return;
    }

    const slotStart = new Date(appt.slot_start);
    const dateStr = new Date(slotStart.getTime() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const keyboard = new InlineKeyboard()
      .text('✅ Да, отменить', `appt_cancel_confirm:${appt.id}`)
      .text('Нет', 'appt_cancel_no');

    await ctx.reply(
      `❌ <b>Отменить запись?</b>\n\n${escapeHtml(appt.services?.name ?? '—')}\n${formatDateLabel(dateStr)} в ${formatTimeLabel(slotStart)}`,
      { parse_mode: 'HTML', reply_markup: keyboard.toJSON() }
    );
  });

  bot.action('appt_cancel_no', async (ctx) => {
    await ctx.answerCallbackQuery('Оставлено без изменений');
    await clearButtons(bot, ctx);
  });

  bot.action(/^appt_cancel_confirm:/, async (ctx) => {
    const id = (ctx.callbackQuery!.data ?? '').replace('appt_cancel_confirm:', '');
    await ctx.answerCallbackQuery();
    await clearButtons(bot, ctx);

    const userId = ctx.callbackQuery!.from.id;

    const { data } = await db
      .from('appointments')
      .select('id, master_id, client_id, slot_start, status, services(name)')
      .eq('id', id)
      .eq('bot_id', record.id)
      .maybeSingle();

    const appt = data as unknown as {
      id: string; master_id: number; client_id: number; slot_start: string;
      status: string; services: { name: string } | null;
    } | null;

    if (!appt || appt.status !== 'confirmed') {
      await ctx.reply('Эта запись уже не активна.');
      return;
    }
    if (appt.client_id !== userId && appt.master_id !== userId) {
      await ctx.reply('Запись не найдена.');
      return;
    }

    // .eq('status', 'confirmed') в самом update — на случай если обе стороны
    // умудрились одновременно отменить одну и ту же запись
    const { error } = await db
      .from('appointments')
      .update({ status: 'cancelled' })
      .eq('id', appt.id)
      .eq('status', 'confirmed');

    if (error) {
      console.error(`[${record.city_name}] Ошибка отмены записи:`, error.message);
      await ctx.reply('❌ Не удалось отменить запись. Попробуйте позже.');
      return;
    }

    const slotStart = new Date(appt.slot_start);
    const dateStr = new Date(slotStart.getTime() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const serviceName = appt.services?.name ?? '—';
    const isClient = userId === appt.client_id;
    const otherPartyId = isClient ? appt.master_id : appt.client_id;

    await ctx.reply(
      `✅ Запись отменена.\n\n${escapeHtml(serviceName)}\n${formatDateLabel(dateStr)} в ${formatTimeLabel(slotStart)}`
    );

    try {
      let actorName = isClient ? 'Клиент' : 'Мастер';
      try {
        const actorChat = await bot.getChat(userId);
        if (actorChat.first_name) actorName = actorChat.first_name;
      } catch {
        // не критично
      }

      await bot.sendMessage(
        otherPartyId,
        `❌ <b>${escapeHtml(actorName)} отменил(а) запись</b>\n\n` +
          `${escapeHtml(serviceName)}\n` +
          `${formatDateLabel(dateStr)} в ${formatTimeLabel(slotStart)}`,
        { parse_mode: 'HTML' }
      );
    } catch (err) {
      console.error(`[${record.city_name}] Ошибка уведомления об отмене записи:`, err);
    }
  });
}
import { InlineKeyboard } from "ultra-telegram-framework";
import type { TelegramBot, SceneContext } from "ultra-telegram-framework";
import { db, type BotRecord } from "../../db.js";
import { escapeHtml } from "../../shared/telegram-html.js";
import { getDistricts, buildListKeyboard } from "../../shared/districts.js";

function buildEditKeyboard(isActive: boolean): InlineKeyboard {
  return new InlineKeyboard()
    .text(isActive ? "⏸ Пауза" : "✅ Активировать", "toggle:active")
    .text("✏️ Фото", "edit:photos")
    .row()
    .text("💰 Цена", "edit:price")
    .text("📍 Район", "edit:district")
    .row()
    .text("🔧 Услуги", "edit:services");
}

// Показываем профиль мастера
export async function showMasterProfile(
  ctx: SceneContext,
  telegramId: number,
  botId: number,
): Promise<void> {
  const { data } = await db
    .from("masters_profiles")
    .select(
      `
      name, price_from, photos, is_active,
      districts(name),
      sub_districts(name),
      master_services(services(name))
    `,
    )
    .eq("master_id", telegramId)
    .eq("bot_id", botId)
    .maybeSingle();

  if (!data) {
    await ctx.reply("Профиль не найден. Пройдите регистрацию заново используйте /start");
    return;
  }

  const raw = data as Record<string, unknown>;

  const districtName = (raw.districts as { name: string } | null)?.name ?? "";
  const subDistrictName =
    (raw.sub_districts as { name: string } | null)?.name ?? "";
  const location = subDistrictName
    ? `${districtName} → ${subDistrictName}`
    : districtName || "—";

  const services = (
    (raw.master_services as Array<{ services: { name: string } }>) ?? []
  )
    .map((ms) => ms.services?.name)
    .filter(Boolean)
    .join(", ");

  const status = raw.is_active ? "✅ Активен" : "⏸ На паузе";

  const text =
    `👤 <b>${escapeHtml(raw.name as string)}</b>\n` +
    `💼 ${escapeHtml(services)}\n` +
    `📍 ${escapeHtml(location || "—")}\n` +
    `💰 от ${raw.price_from} грн\n` +
    `${status}`;

  const photos = raw.photos as string[];

  if (photos && photos.length > 0) {
    const keyboard = new InlineKeyboard().text(
      `🖼 Показать фото (${photos.length})`,
      'show:photos'
    );
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard.toJSON() });
  } else {
    await ctx.reply(text, { parse_mode: 'HTML' });
  }
}


export function registerProfileHandlers(
  bot: TelegramBot<SceneContext>,
  record: BotRecord,
): void {
  // Кнопка «Мой профиль»
  // Показ фото — только по явному запросу (см. showMasterProfile), чтобы не
  // засорять историю чата (и вкладку «Медиа» в Telegram) дублями одних и тех
  // же фото при каждом заходе в «Мой профиль»
  bot.action("show:photos", async (ctx) => {
    const telegramId = ctx.callbackQuery!.from.id;
    await ctx.answerCallbackQuery();

    const { data } = await db
      .from("masters_profiles")
      .select("photos")
      .eq("master_id", telegramId)
      .eq("bot_id", record.id)
      .maybeSingle();

    const photos = (data as { photos: string[] } | null)?.photos ?? [];

    if (photos.length === 0) {
      await ctx.reply("Фото пока не добавлены.");
      return;
    }

    try {
      await ctx.replyWithMediaGroup(
        photos.map((fileId) => ({ type: "photo" as const, media: fileId })),
      );
    } catch (err) {
      console.error(`[${record.city_name}] Ошибка отправки фото профиля:`, err);
      await ctx.reply("⚠️ Не удалось загрузить фото.");
    }
  });

  bot.match("👤 Мой профиль", async (ctx) => {
    const telegramId =
      ctx.message && "from" in ctx.message ? ctx.message.from?.id : undefined;

    if (!telegramId) return;

    await showMasterProfile(ctx, telegramId, record.id);
  });
  bot.match("⚙️ Редактировать", async (ctx) => {
    const telegramId =
      ctx.message && "from" in ctx.message ? ctx.message.from?.id : undefined;

    if (!telegramId) return;

    const { data } = await db
      .from("masters_profiles")
      .select("is_active")
      .eq("master_id", telegramId)
      .eq("bot_id", record.id)
      .maybeSingle();

    if (!data) {
      await ctx.reply("Профиль не найден. Пройдите регистрацию заново используйте /start");
      return;
    }

    await ctx.reply("Управление профилем:", {
      reply_markup: buildEditKeyboard(Boolean(data.is_active)).toJSON(),
    });
  });
  // Редактирование фото
  bot.action("edit:photos", async (ctx) => {
    const telegramId = ctx.callbackQuery!.from.id;
    await ctx.answerCallbackQuery();

    const { data } = await db
      .from("masters_profiles")
      .select("photos")
      .eq("master_id", telegramId)
      .eq("bot_id", record.id)
      .maybeSingle();

    const photos = (data as { photos: string[] } | null)?.photos ?? [];

    await ctx.reply(
      `📸 Сейчас у вас ${photos.length} фото в портфолио.\n\n` +
        `Отправьте новые фото (до 5) чтобы заменить все.\n` +
        `/done — сохранить\n` +
        `/skip — удалить все фото`,
    );

    ctx.scene.enter("edit_photos");
    ctx.scene.state.photos = [];
  });

  // Редактирование услуг
  bot.action("edit:services", async (ctx) => {
    const telegramId = ctx.callbackQuery!.from.id;
    await ctx.answerCallbackQuery();

    const { data: allServices } = await db
      .from("bot_services")
      .select("services(id, name)")
      .eq("bot_id", record.id)
      .eq("is_enabled", true);

    const services = (
      allServices as unknown as Array<{
        services: { id: number; name: string };
      }>
    )
      .map((r) => r.services)
      .filter(Boolean);

    const { data: currentServices } = await db
      .from("master_services")
      .select("service_id")
      .eq("master_id", telegramId)
      .eq("bot_id", record.id);

    const selected = (
      (currentServices as Array<{ service_id: number }>) ?? []
    ).map((r) => r.service_id);

    const keyboard = new InlineKeyboard();
    const PER_ROW = 3;
    services.forEach((s, i) => {
      keyboard.text(
        `${selected.includes(s.id) ? "✅" : "☐"} ${s.name}`,
        `svc:${s.id}`,
      );
      if ((i + 1) % PER_ROW === 0) keyboard.row();
    });
    if (services.length % PER_ROW !== 0) keyboard.row();
    keyboard.text("✔️ Готово", "svc:done");

    await ctx.reply("🔧 Выберите ваши услуги:", {
      reply_markup: keyboard.toJSON(),
    });

    ctx.scene.enter("edit_services");
    ctx.scene.state.services = services;
    ctx.scene.state.selected = selected;
  });

  // Редактирование района
  bot.action("edit:district", async (ctx) => {
    await ctx.answerCallbackQuery();

    const districts = await getDistricts(record.id);
    if (districts.length === 0) {
      return ctx.reply("⚠️ Районы не настроены.");
    }

    await ctx.reply("📍 Выберите новый район:", {
      reply_markup: buildListKeyboard(districts, "district").toJSON(),
    });

    ctx.scene.enter("edit_district");
  });

  // Редактирование цены
  bot.action("edit:price", async (ctx) => {
    const userId = ctx.callbackQuery!.from.id;
    await ctx.answerCallbackQuery();
    await ctx.reply("💰 Введите новую минимальную цену (в грн):");
    ctx.scene.enter("edit_price");
  });

  // Переключение статуса активности
  bot.action("toggle:active", async (ctx) => {
    const telegramId = ctx.callbackQuery!.from.id;

    try {
      const { data: profile } = await db
        .from("masters_profiles")
        .select("is_active")
        .eq("master_id", telegramId)
        .eq("bot_id", record.id)
        .maybeSingle();

      if (!profile) return ctx.answerCallbackQuery("Профиль не найден");

      const newStatus = !profile.is_active;

      const { error: updateError } = await db
        .from("masters_profiles")
        .update({ is_active: newStatus })
        .eq("master_id", telegramId)
        .eq("bot_id", record.id);

      if (updateError) {
        console.error(
          `[${record.city_name}] Ошибка toggle:active:`,
          updateError.message,
        );
        return ctx.answerCallbackQuery("⚠️ Не удалось обновить статус");
      }

      await ctx.answerCallbackQuery(
        newStatus ? "✅ Вы снова активны!" : "⏸ Вы на паузе",
      );

      // Обновляем профиль
      // Обновляем меню редактирования (не карточку — toggle вызывается
      // именно из меню редактирования, пользователь должен там и остаться)
      await ctx.reply('Управление профилем:', {
        reply_markup: buildEditKeyboard(newStatus).toJSON()
      });
    } catch (err) {
      console.error(
        `[${record.city_name}] Ошибка toggle:active userId=${telegramId}:`,
        err,
      );
      await ctx
        .answerCallbackQuery("⚠️ Ошибка, попробуйте ещё раз")
        .catch(() => {});
    }
  });
}
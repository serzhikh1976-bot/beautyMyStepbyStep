import { WizardScene, InlineKeyboard } from 'ultra-telegram-framework';
import type { SceneContext } from 'ultra-telegram-framework';
import { db } from '../db.js';

const DAY_LABELS: Record<number, string> = {
  1: 'Пн', 2: 'Вт', 3: 'Ср', 4: 'Чт', 5: 'Пт', 6: 'Сб', 7: 'Вс'
};
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 7];

export function buildDaysKeyboard(selected: number[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  DAY_ORDER.forEach((day, i) => {
    kb.text(`${selected.includes(day) ? '✅' : '☐'} ${DAY_LABELS[day]}`, `day:${day}`);
    if ((i + 1) % 3 === 0) kb.row();
  });
  if (DAY_ORDER.length % 3 !== 0) kb.row();
  kb.text('✔️ Готово', 'day:done');
  return kb;
}

function parseTime(input: string): string | null {
  const match = input.trim().match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!match) return null;
  const hh = match[1].padStart(2, '0');
  return `${hh}:${match[2]}`;
}

function timeToMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

export function createScheduleSettingsScene(botId: number) {
  return new WizardScene<SceneContext>(
    'schedule_settings',

    // Step 0: ждём callback — мультиселект рабочих дней
    async (ctx) => {
      if (!ctx.callbackQuery) return;

      const data = ctx.callbackQuery.data;
      const selected = ctx.scene.state.selectedDays as number[];

      if (data?.startsWith('day:') && data !== 'day:done') {
        const day = parseInt(data.replace('day:', ''));
        const idx = selected.indexOf(day);
        if (idx === -1) selected.push(day);
        else selected.splice(idx, 1);

        await ctx.editReplyMarkup(
          buildDaysKeyboard(selected).toJSON() as Parameters<typeof ctx.editReplyMarkup>[0]
        );
        return ctx.answerCallbackQuery();
      }

      if (data === 'day:done') {
        if (selected.length === 0) {
          return ctx.answerCallbackQuery('Выберите хотя бы один рабочий день!');
        }
        await ctx.answerCallbackQuery();
        await ctx.reply('🕐 Введите время начала рабочего дня (формат ЧЧ:ММ, например 09:00):');
        ctx.scene.next();
      }
    },

    // Step 1: время начала
    async (ctx) => {
      if (!ctx.text) return;

      const startTime = parseTime(ctx.text);
      if (!startTime) {
        return ctx.reply('Неверный формат. Введите время как ЧЧ:ММ, например 09:00:');
      }

      ctx.scene.state.startTime = startTime;
      await ctx.reply('🕐 Теперь время окончания рабочего дня (формат ЧЧ:ММ, например 18:00):');
      ctx.scene.next();
    },

    // Step 2: время окончания
    async (ctx) => {
      if (!ctx.text) return;

      const endTime = parseTime(ctx.text);
      if (!endTime) {
        return ctx.reply('Неверный формат. Введите время как ЧЧ:ММ, например 18:00:');
      }

      const startTime = ctx.scene.state.startTime as string;
      if (timeToMinutes(endTime) <= timeToMinutes(startTime)) {
        return ctx.reply(`Время окончания должно быть позже начала (${startTime}). Введите ещё раз:`);
      }

      ctx.scene.state.endTime = endTime;
      await ctx.reply('🔔 За сколько минут до записи напоминать ВАМ? (число, например 60):');
      ctx.scene.next();
    },

    // Step 3: напоминание мастеру
    async (ctx) => {
      if (!ctx.text) return;

      const minutes = parseInt(ctx.text.trim());
      if (isNaN(minutes) || minutes < 0 || minutes > 1440) {
        return ctx.reply('Введите число минут от 0 до 1440 (сутки):');
      }

      ctx.scene.state.reminderMaster = minutes;
      await ctx.reply('🔔 За сколько минут до записи напоминать КЛИЕНТУ? (число, например 120):');
      ctx.scene.next();
    },

    // Step 4: напоминание клиенту — сохраняем всё
    async (ctx) => {
      if (!ctx.text) return;

      const minutes = parseInt(ctx.text.trim());
      if (isNaN(minutes) || minutes < 0 || minutes > 1440) {
        return ctx.reply('Введите число минут от 0 до 1440 (сутки):');
      }

      const telegramId = ctx.message && 'from' in ctx.message
        ? ctx.message.from?.id
        : undefined;
      if (!telegramId) return ctx.scene.leave();

      const { error } = await db.from('master_schedule_settings').upsert({
        master_id: telegramId,
        bot_id: botId,
        working_days: ctx.scene.state.selectedDays as number[],
        start_time: ctx.scene.state.startTime as string,
        end_time: ctx.scene.state.endTime as string,
        reminder_master_minutes_before: ctx.scene.state.reminderMaster as number,
        reminder_client_minutes_before: minutes,
        updated_at: new Date().toISOString()
      }, { onConflict: 'master_id,bot_id' });

      if (error) {
        console.error('[scheduleSettings] Ошибка сохранения:', error.message);
        await ctx.reply('❌ Ошибка сохранения. Попробуйте позже.');
      } else {
        const days = (ctx.scene.state.selectedDays as number[])
          .sort((a, b) => a - b)
          .map((d) => DAY_LABELS[d])
          .join(', ');
        await ctx.reply(
          `✅ Расписание сохранено!\n\n` +
            `Рабочие дни: ${days}\n` +
            `Часы: ${ctx.scene.state.startTime}–${ctx.scene.state.endTime}\n` +
            `Напоминание вам: за ${ctx.scene.state.reminderMaster} мин\n` +
            `Напоминание клиенту: за ${minutes} мин`
        );
      }

      ctx.scene.leave();
    }
  );
}
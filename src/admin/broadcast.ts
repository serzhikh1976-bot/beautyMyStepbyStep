import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { db } from '../db.js';
import { escapeHtml, layout, requireAuth } from './shared.js';
import { getBot } from '../bot/index.js';

interface Recipient {
  master_id: number;
  bot_id: number;
  name: string;
  city_name: string;
}

// Собираем список получателей по фильтрам. Приоритет: конкретный мастер >
// группа по услуге > все мастера в выбранной области (город или все города).
async function resolveRecipients(
  cityId: number | null,
  serviceId: number | null,
  masterId: number | null
): Promise<Recipient[]> {
  if (masterId && cityId) {
    const { data } = await db
      .from('masters_profiles')
      .select('master_id, bot_id, name, bots(city_name)')
      .eq('master_id', masterId)
      .eq('bot_id', cityId)
      .maybeSingle();

    if (!data) return [];
    const row = data as unknown as { master_id: number; bot_id: number; name: string; bots: { city_name: string } | null };
    return [{ master_id: row.master_id, bot_id: row.bot_id, name: row.name, city_name: row.bots?.city_name ?? '—' }];
  }

  let query = db
    .from('masters_profiles')
    .select(
      serviceId
        ? 'master_id, bot_id, name, bots(city_name), master_services!inner(service_id)'
        : 'master_id, bot_id, name, bots(city_name)'
    );

  if (cityId) query = query.eq('bot_id', cityId);
  if (serviceId) query = query.eq('master_services.service_id', serviceId);

  const { data, error } = await query;

  if (error) {
    console.error('[AdminBroadcast] Ошибка выборки получателей:', error.message);
    return [];
  }

  return ((data as unknown as Array<{ master_id: number; bot_id: number; name: string; bots: { city_name: string } | null }>) ?? [])
    .map((r) => ({ master_id: r.master_id, bot_id: r.bot_id, name: r.name, city_name: r.bots?.city_name ?? '—' }));
}

// ── Форма ────────────────────────────────────────────────────────────────

async function handleBroadcastForm(request: FastifyRequest, reply: FastifyReply) {
  if (!requireAuth(request, reply)) return;

  const query = request.query as { city?: string };
  const cityId = query.city ? Number(query.city) : null;

  const [{ data: citiesRaw }, { data: servicesRaw }] = await Promise.all([
    db.from('bots').select('id, city_name').order('city_name'),
    db.from('services').select('id, name').order('name')
  ]);

  const cities = (citiesRaw as Array<{ id: number; city_name: string }>) ?? [];
  const services = (servicesRaw as Array<{ id: number; name: string }>) ?? [];

  let mastersInCity: Array<{ master_id: number; name: string }> = [];
  if (cityId) {
    const { data } = await db
      .from('masters_profiles')
      .select('master_id, name')
      .eq('bot_id', cityId)
      .order('name');
    mastersInCity = (data as Array<{ master_id: number; name: string }>) ?? [];
  }

  const cityOptions = ['<option value="">Все города</option>']
    .concat(cities.map((c) => `<option value="${c.id}" ${cityId === c.id ? 'selected' : ''}>${escapeHtml(c.city_name)}</option>`))
    .join('');

  const serviceOptions = ['<option value="">Все услуги</option>']
    .concat(services.map((s) => `<option value="${s.id}">${escapeHtml(s.name)}</option>`))
    .join('');

  const masterOptions = ['<option value="">Не выбирать конкретного</option>']
    .concat(mastersInCity.map((m) => `<option value="${m.master_id}">${escapeHtml(m.name)}</option>`))
    .join('');

  const masterFieldNote = cityId
    ? ''
    : '<div style="font-size:13px;color:#888;margin-top:4px;">Выбор конкретного мастера доступен только при выбранном городе</div>';

  const body = `
    <h1 style="margin-top:0;">Рассылка сообщений</h1>
    <div class="card">
      <form method="GET" action="/admin/broadcast" class="filters" style="margin-bottom:20px;">
        <label>Город
          <select name="city" onchange="this.form.submit()">${cityOptions}</select>
        </label>
      </form>

      <form method="POST" action="/admin/broadcast/preview">
        <input type="hidden" name="city" value="${cityId ?? ''}" />
        <div style="display:flex;flex-direction:column;gap:14px;max-width:480px;">
          <label>Группа по услуге
            <select name="service">${serviceOptions}</select>
          </label>
          <label>Конкретный мастер
            <select name="master" ${cityId ? '' : 'disabled'}>${masterOptions}</select>
            ${masterFieldNote}
          </label>
          <label>Сообщение
            <textarea name="message" rows="5" required placeholder="Текст сообщения мастерам..."></textarea>
          </label>
          <button type="submit">Показать получателей</button>
        </div>
      </form>
    </div>`;

  reply.type('text/html').send(layout('Рассылка', body, { activePath: '/admin/broadcast' }));
}

// ── Предпросмотр получателей ────────────────────────────────────────────

async function handleBroadcastPreview(request: FastifyRequest, reply: FastifyReply) {
  if (!requireAuth(request, reply)) return;

  const body = request.body as { city?: string; service?: string; master?: string; message?: string };
  const cityId = body.city?.trim() ? Number(body.city.trim()) : null;
  const serviceId = body.service?.trim() ? Number(body.service.trim()) : null;
  const masterId = body.master?.trim() ? Number(body.master.trim()) : null;
  const message = (body.message ?? '').trim();

  if (!message) {
    return reply.type('text/html').send(layout('Рассылка', '<div class="card">⚠️ Сообщение не может быть пустым. <a class="link" href="/admin/broadcast">Назад</a></div>', { activePath: '/admin/broadcast' }));
  }

  const recipients = await resolveRecipients(cityId, serviceId, masterId);

  if (recipients.length === 0) {
    return reply.type('text/html').send(layout('Рассылка', '<div class="card">Получателей по этим фильтрам не найдено. <a class="link" href="/admin/broadcast">Назад</a></div>', { activePath: '/admin/broadcast' }));
  }

  const list = recipients
    .slice(0, 30)
    .map((r) => `<li>${escapeHtml(r.name)} · ${escapeHtml(r.city_name)}</li>`)
    .join('');
  const moreNote = recipients.length > 30 ? `<div style="color:#888;margin-top:6px;">…и ещё ${recipients.length - 30}</div>` : '';

  const body_ = `
    <h1 style="margin-top:0;">Подтверждение рассылки</h1>
    <div class="card">
      <p><b>Получателей: ${recipients.length}</b></p>
      <ul>${list}</ul>
      ${moreNote}
      <div class="support-question" style="margin-top:16px;">💬 ${escapeHtml(message)}</div>
      <form method="POST" action="/admin/broadcast/send" style="margin-top:20px;display:flex;gap:10px;">
        <input type="hidden" name="city" value="${cityId ?? ''}" />
        <input type="hidden" name="service" value="${serviceId ?? ''}" />
        <input type="hidden" name="master" value="${masterId ?? ''}" />
        <input type="hidden" name="message" value="${escapeHtml(message)}" />
        <button type="submit">✅ Подтвердить и отправить ${recipients.length} мастерам</button>
        <a class="link" href="/admin/broadcast">Отмена</a>
      </form>
    </div>`;

  reply.type('text/html').send(layout('Рассылка', body_, { activePath: '/admin/broadcast' }));
}

// ── Реальная отправка ───────────────────────────────────────────────────

async function handleBroadcastSend(request: FastifyRequest, reply: FastifyReply) {
  if (!requireAuth(request, reply)) return;

  const body = request.body as { city?: string; service?: string; master?: string; message?: string };
  const cityId = body.city?.trim() ? Number(body.city.trim()) : null;
  const serviceId = body.service?.trim() ? Number(body.service.trim()) : null;
  const masterId = body.master?.trim() ? Number(body.master.trim()) : null;
  const message = (body.message ?? '').trim();

  if (!message) {
    return reply.type('text/html').send(layout('Рассылка', '<div class="card">⚠️ Сообщение пустое. <a class="link" href="/admin/broadcast">Назад</a></div>', { activePath: '/admin/broadcast' }));
  }

  const recipients = await resolveRecipients(cityId, serviceId, masterId);

  // Группируем по городу, чтобы не резолвить city-бот на каждого мастера заново
  const byCity = new Map<number, Recipient[]>();
  for (const r of recipients) {
    if (!byCity.has(r.bot_id)) byCity.set(r.bot_id, []);
    byCity.get(r.bot_id)!.push(r);
  }

  let sent = 0;
  let failed = 0;

  for (const [botId, list] of byCity) {
    const { data: botRow } = await db.from('bots').select('number').eq('id', botId).maybeSingle();
    const uuid = (botRow as { number: string } | null)?.number;
    if (!uuid) {
      failed += list.length;
      continue;
    }

    const cityBot = await getBot(uuid);
    if (!cityBot) {
      failed += list.length;
      continue;
    }

    for (const r of list) {
      try {
        await cityBot.sendMessage(r.master_id, `📢 <b>Сообщение от администрации:</b>\n\n${escapeHtml(message)}`, { parse_mode: 'HTML' });
        sent++;
      } catch (err) {
        console.error(`[AdminBroadcast] Не удалось отправить master_id=${r.master_id}:`, err);
        failed++;
      }
      // Небольшая пауза, чтобы не упереться в лимиты Telegram при массовой рассылке
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  const resultBody = `
    <h1 style="margin-top:0;">Рассылка завершена</h1>
    <div class="card">
      <p>✅ Отправлено: <b>${sent}</b></p>
      ${failed > 0 ? `<p>❌ Не удалось: <b>${failed}</b> (мастер мог заблокировать бота)</p>` : ''}
      <a class="link" href="/admin/broadcast">← Новая рассылка</a>
    </div>`;

  reply.type('text/html').send(layout('Рассылка', resultBody, { activePath: '/admin/broadcast' }));
}

export function registerAdminBroadcastRoutes(app: FastifyInstance): void {
  app.get('/admin/broadcast', handleBroadcastForm);
  app.post('/admin/broadcast/preview', handleBroadcastPreview);
  app.post('/admin/broadcast/send', handleBroadcastSend);
}
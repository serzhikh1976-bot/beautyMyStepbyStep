import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { db } from '../db.js';
import { escapeHtml, layout, requireAuth } from './shared.js';
import { getBot } from '../bot/index.js';

async function handleSupportList(request: FastifyRequest, reply: FastifyReply) {
  if (!requireAuth(request, reply)) return;

  const query = request.query as { city?: string; status?: string };
  const cityFilter = query.city ? Number(query.city) : null;
  const statusFilter = query.status === 'answered' || query.status === 'unanswered' ? query.status : 'all';

  const { data: citiesRaw } = await db.from('bots').select('id, city_name').order('city_name');
  const cities = (citiesRaw as Array<{ id: number; city_name: string }>) ?? [];

  let threadsQuery = db
    .from('support_messages')
    .select('id, bot_id, master_id, message_text, created_at, bots(city_name)')
    .order('created_at', { ascending: false })
    .limit(200);

  if (cityFilter) threadsQuery = threadsQuery.eq('bot_id', cityFilter);

  const { data: threadsRaw, error } = await threadsQuery;

  if (error) {
    console.error('[AdminSupport] Ошибка загрузки обращений:', error.message);
    return reply.type('text/html').send(layout('Поддержка', '<div class="card">⚠️ Не удалось загрузить данные.</div>', { activePath: '/admin/support' }));
  }

  let threads = (threadsRaw as unknown as Array<{
    id: number;
    bot_id: number;
    master_id: number;
    message_text: string;
    created_at: string;
    bots: { city_name: string } | null;
  }>) ?? [];

  const cityOptions = ['<option value="">Все города</option>']
    .concat(cities.map((c) => `<option value="${c.id}" ${cityFilter === c.id ? 'selected' : ''}>${escapeHtml(c.city_name)}</option>`))
    .join('');

  const statusOptions = `
    <option value="all" ${statusFilter === 'all' ? 'selected' : ''}>Все</option>
    <option value="unanswered" ${statusFilter === 'unanswered' ? 'selected' : ''}>Без ответа</option>
    <option value="answered" ${statusFilter === 'answered' ? 'selected' : ''}>Отвечено</option>`;

  const filters = `
  <form class="filters card" method="GET" action="/admin/support">
    <label>Город
      <select name="city" onchange="this.form.submit()">${cityOptions}</select>
    </label>
    <label>Статус
      <select name="status" onchange="this.form.submit()">${statusOptions}</select>
    </label>
  </form>`;

  if (threads.length === 0) {
    return reply.type('text/html').send(layout('Поддержка', `${filters}<div class="card empty">Обращений не найдено.</div>`, { activePath: '/admin/support' }));
  }

  const threadIds = threads.map((t) => t.id);

  // Имена мастеров — отдельным запросом, т.к. между support_messages и
  // masters_profiles нет прямого FK (мастер мог удалить профиль, а
  // обращение в истории должно остаться)
  const { data: mastersRaw } = await db
    .from('masters_profiles')
    .select('master_id, bot_id, name')
    .in('bot_id', [...new Set(threads.map((t) => t.bot_id))]);

  const masterNames = new Map<string, string>();
  for (const m of (mastersRaw as Array<{ master_id: number; bot_id: number; name: string }>) ?? []) {
    masterNames.set(`${m.master_id}:${m.bot_id}`, m.name);
  }

  const { data: repliesRaw } = await db
    .from('support_replies')
    .select('support_message_id, reply_text, created_at, admin_telegram_id')
    .in('support_message_id', threadIds)
    .order('created_at', { ascending: true });

  const repliesByThread = new Map<number, Array<{ reply_text: string; created_at: string; admin_telegram_id: number }>>();
  for (const r of (repliesRaw as Array<{ support_message_id: number; reply_text: string; created_at: string; admin_telegram_id: number }>) ?? []) {
    if (!repliesByThread.has(r.support_message_id)) repliesByThread.set(r.support_message_id, []);
    repliesByThread.get(r.support_message_id)!.push(r);
  }

  if (statusFilter === 'answered') {
    threads = threads.filter((t) => repliesByThread.has(t.id));
  } else if (statusFilter === 'unanswered') {
    threads = threads.filter((t) => !repliesByThread.has(t.id));
  }

  if (threads.length === 0) {
    return reply.type('text/html').send(layout('Поддержка', `${filters}<div class="card empty">Обращений не найдено.</div>`, { activePath: '/admin/support' }));
  }

  const cards = threads
    .map((t) => {
      const masterName = masterNames.get(`${t.master_id}:${t.bot_id}`) ?? `ID ${t.master_id}`;
      const cityName = t.bots?.city_name ?? '—';
      const createdAt = new Date(t.created_at).toLocaleString('ru-RU');
      const replies = repliesByThread.get(t.id) ?? [];

      const repliesHtml = replies.length > 0
        ? replies
            .map(
              (r) => `
        <div class="support-reply">
          <div class="support-reply-meta">${r.admin_telegram_id === 0 ? '🌐 Ответ из вебадминки' : '↩️ Ответ'} · ${new Date(r.created_at).toLocaleString('ru-RU')}</div>
          <div>${escapeHtml(r.reply_text)}</div>
        </div>`
            )
            .join('')
        : '<div class="support-reply support-reply-empty">Пока без ответа</div>';

      return `
    <div class="card support-thread">
      <div class="support-thread-header">
        <b>${escapeHtml(masterName)}</b> · ${escapeHtml(cityName)}
        <span class="support-thread-date">${createdAt}</span>
      </div>
      <div class="support-question">💬 ${escapeHtml(t.message_text)}</div>
      ${repliesHtml}
      <form method="POST" action="/admin/support/${t.id}/reply" style="margin-top:12px;display:flex;gap:8px;">
        <input type="text" name="reply_text" placeholder="Ответить мастеру..." required style="flex:1;" />
        <button type="submit">Отправить</button>
      </form>
    </div>`;
    })
    .join('');

  const body = `<h1 style="margin-top:0;">Поддержка (${threads.length})</h1>${filters}${cards}`;

  reply.type('text/html').send(layout('Поддержка', body, { activePath: '/admin/support' }));
}

async function handleSupportReply(request: FastifyRequest, reply: FastifyReply) {
  if (!requireAuth(request, reply)) return;

  const { threadId } = request.params as { threadId: string };
  const body = request.body as { reply_text?: string };
  const replyText = (body.reply_text ?? '').trim();

  if (!replyText) {
    return reply.redirect('/admin/support');
  }

  const { data: thread } = await db
    .from('support_messages')
    .select('id, bot_id, master_id')
    .eq('id', Number(threadId))
    .maybeSingle();

  if (!thread) {
    return reply.redirect('/admin/support');
  }

  const raw = thread as { id: number; bot_id: number; master_id: number };

  const { data: botRow } = await db.from('bots').select('number').eq('id', raw.bot_id).maybeSingle();
  const uuid = (botRow as { number: string } | null)?.number;

  if (uuid) {
    const cityBot = await getBot(uuid);
    if (cityBot) {
      try {
        await cityBot.sendMessage(
          raw.master_id,
          `💬 <b>Ответ от поддержки:</b>\n\n${escapeHtml(replyText)}`,
          { parse_mode: 'HTML' }
        );
      } catch (err) {
        console.error('[AdminSupport] Ошибка отправки ответа мастеру:', err);
      }
    }
  }

  // admin_telegram_id: 0 — маркер "ответ отправлен из вебадминки", а не
  // через Reply в Telegram-боте (для веб-сессии нет привязки к конкретному
  // Telegram-аккаунту, только общий пароль на панель)
  await db.from('support_replies').insert({
    support_message_id: raw.id,
    reply_text: replyText,
    admin_telegram_id: 0
  });

  reply.redirect('/admin/support');
}

export function registerAdminSupportRoutes(app: FastifyInstance): void {
  app.get('/admin/support', handleSupportList);
  app.post('/admin/support/:threadId/reply', handleSupportReply);
}
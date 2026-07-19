import 'dotenv/config';
import { buildServer } from './server.js';
import { startAutoCloseChatsJob } from './jobs/auto-close-chats.js';
import { backfillCommunityTopics } from './community/topics.js';

const PORT = Number(process.env.PORT ?? 3000);

const app = await buildServer();

try {
  await app.listen({ port: PORT, host: '0.0.0.0' });
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
  console.log(`📡 Вебхуки: POST /webhook/:uuid`);
  console.log(`❤️  Health: GET /`);
  startAutoCloseChatsJob();
  backfillCommunityTopics().catch(err => console.error('[Community] Ошибка бэкфилла тем:', err));
} catch (err) {
  console.error('Ошибка запуска:', err);
  process.exit(1);
}

process.once('SIGINT', async () => { await app.close(); process.exit(0); });
process.once('SIGTERM', async () => { await app.close(); process.exit(0); });
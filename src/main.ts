import { drive } from '@googleapis/drive';
import { sheets } from '@googleapis/sheets';
import { autoRetry } from '@grammyjs/auto-retry';
import { serve } from '@hono/node-server';
import { Bot } from 'grammy';
import { loadConfig } from './config.js';
import { createLogger } from './core/logger.js';
import { systemClock } from './core/time.js';
import { LinkSigner } from './core/tokens.js';
import { googleClient } from './google/auth.js';
import { DrivePhotoStore } from './photos/drive.js';
import { MemoryPhotoStore } from './photos/memory.js';
import { startScheduler } from './scheduler.js';
import { Links } from './services/links.js';
import { RequestService } from './services/service.js';
import { HttpSiteChecker } from './site/checker.js';
import { MemoryRepository } from './storage/memory.js';
import type { Repository } from './storage/repository.js';
import { GoogleSheetsGateway } from './storage/sheets/gateway.js';
import { SheetsRepository } from './storage/sheets/repository.js';
import { registerHandlers } from './telegram/bot.js';
import { TelegramNotifier } from './telegram/notifier.js';
import { createWebApp } from './web/app.js';

let config: ReturnType<typeof loadConfig>;
try {
  config = loadConfig(process.env);
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
const log = createLogger(config.LOG_LEVEL);
const tz = config.TIMEZONE;

const bot = new Bot(config.TELEGRAM_BOT_TOKEN);
bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 30 }));
log.info('Подключаюсь к Telegram');
try {
  // типы grammY ждут AbortSignal из полифилла, в Node он совместим со встроенным
  await bot.init(AbortSignal.timeout(60_000) as Parameters<typeof bot.init>[0]);
} catch (error) {
  // Docker перезапустит сервис; причина — в журнале
  log.error('Не удалось связаться с Telegram: проверьте токен и доступ к api.telegram.org', {
    error,
  });
  process.exit(1);
}
const inviteLinkBase = `https://t.me/${bot.botInfo.username}?start=`;

let repo: Repository;
let photos: DrivePhotoStore | MemoryPhotoStore;
if (config.STORAGE === 'sheets') {
  const auth = googleClient({
    clientId: config.GOOGLE_CLIENT_ID!,
    clientSecret: config.GOOGLE_CLIENT_SECRET!,
    refreshToken: config.GOOGLE_REFRESH_TOKEN!,
  });
  repo = new SheetsRepository(
    new GoogleSheetsGateway(sheets({ version: 'v4', auth }), config.SPREADSHEET_ID!),
    { tz, inviteLinkBase },
  );
  photos = new DrivePhotoStore(drive({ version: 'v3', auth }), config.PHOTOS_FOLDER_ID!);
} else {
  log.warn('STORAGE=memory: данные живут только в памяти, для проверки и разработки');
  repo = new MemoryRepository();
  photos = new MemoryPhotoStore();
}

const ops = {
  chatId: config.OPS_CHAT_ID,
  ...(config.OPS_TOPIC_ID !== undefined ? { topicId: config.OPS_TOPIC_ID } : {}),
};
const alerts =
  config.ALERT_CHAT_ID !== undefined
    ? {
        chatId: config.ALERT_CHAT_ID,
        ...(config.ALERT_TOPIC_ID !== undefined ? { topicId: config.ALERT_TOPIC_ID } : {}),
      }
    : ops;
const notifier = new TelegramNotifier(bot.api, ops, alerts);
const links = new Links(new LinkSigner(config.LINK_SECRET), config.PUBLIC_BASE_URL, systemClock);
const alert = (text: string) => notifier.alert(text);

const service = new RequestService({
  repo,
  notifier,
  photos,
  links,
  clock: systemClock,
  tz,
  log,
  site: new HttpSiteChecker(config.SITE_BASE_URL),
});

registerHandlers(bot, { opsChatId: config.OPS_CHAT_ID, alert }, service, log);

const server = serve({ fetch: createWebApp({ service, links, log }).fetch, port: config.PORT });
log.info('Форма слушает порт', { port: config.PORT, publicUrl: config.PUBLIC_BASE_URL });

const scheduler = await startScheduler(service, {
  tz,
  syncMinutes: config.REGISTRY_SYNC_MINUTES,
  log,
  alert,
});

await bot.api.setMyCommands(
  [
    { command: 'menu', description: 'Меню' },
    { command: 'help', description: 'Как работает бот' },
  ],
  { scope: { type: 'all_private_chats' } },
);

let stopping = false;
const shutdown = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  log.info('Остановка', { signal });
  scheduler.stop();
  await bot.stop();
  server.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

log.info('Бот запущен', { bot: bot.botInfo.username, storage: config.STORAGE });
// long polling: входящие порты не нужны, обновления идут по одному
await bot.start({ allowed_updates: ['message', 'callback_query'] });

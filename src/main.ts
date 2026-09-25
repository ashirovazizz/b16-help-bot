import path from 'node:path';
import { autoRetry } from '@grammyjs/auto-retry';
import { Cron } from 'croner';
import { Bot } from 'grammy';
import { registerHandlers } from './bot.js';
import { type Config, holidaysOf, loadConfig } from './config.js';
import { createLogger } from './core/logger.js';
import { Desk } from './desk.js';
import type { Binding } from './store.js';
import { Store } from './store.js';

let config: Config;
try {
  config = loadConfig(process.env);
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
const log = createLogger(config.LOG_LEVEL);

const bot = new Bot(config.TELEGRAM_BOT_TOKEN);
bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 30 }));
log.info('Подключаюсь к Telegram');
try {
  // типы grammY ждут AbortSignal из полифилла, в Node он совместим со встроенным
  await bot.init(AbortSignal.timeout(60_000) as Parameters<typeof bot.init>[0]);
} catch (error) {
  // Docker перезапустит бота; причина — в журнале
  log.error('Не удалось связаться с Telegram: проверьте токен и доступ к api.telegram.org', {
    error,
  });
  process.exit(1);
}

const store = await Store.open(path.join(config.DATA_DIR, 'state.json'));
const envBindings: Record<string, Binding> = {};
if (config.OPS_CHAT_ID !== undefined) {
  envBindings.site = {
    chatId: config.OPS_CHAT_ID,
    ...(config.SITE_TOPIC_ID !== undefined ? { threadId: config.SITE_TOPIC_ID } : {}),
  };
}

const desk = new Desk(
  bot.api,
  store,
  {
    ...(config.SETUP_CODE ? { setupCode: config.SETUP_CODE } : {}),
    access: config.ACCESS,
    tz: config.TIMEZONE,
    slaDays: config.SLA_DAYS,
    holidays: holidaysOf(config),
    envBindings,
  },
  log,
);

registerHandlers(bot, desk, log);

let digest: Cron | undefined;
if (config.DIGEST_TIME !== 'off') {
  const [hh, mm] = config.DIGEST_TIME.split(':').map(Number);
  digest = new Cron(
    `${mm} ${hh} * * 1-5`,
    { timezone: config.TIMEZONE, protect: true },
    async () => {
      try {
        await desk.sendDigests();
      } catch (error) {
        log.error('Не удалось отправить сводку', { error });
      }
    },
  );
}

await bot.api.setMyCommands(
  [
    { command: 'start', description: 'Меню' },
    { command: 'help', description: 'Как работает бот' },
  ],
  { scope: { type: 'all_private_chats' } },
);

const shutdown = async (signal: string) => {
  log.info('Остановка', { signal });
  digest?.stop();
  await bot.stop();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

if (!desk.configured) {
  log.warn(
    `Тема для заявок не выбрана. Добавьте @${bot.botInfo.username} в рабочий чат и отправьте в нужной теме: /setup@${bot.botInfo.username} ${config.SETUP_CODE ?? '<SETUP_CODE из .env>'}`,
  );
}
log.info('Бот запущен', { bot: bot.botInfo.username });
// long polling: бот сам забирает обновления, входящие порты не нужны
await bot.start({ allowed_updates: ['message', 'callback_query', 'my_chat_member'] });

import path from 'node:path';
import { autoRetry } from '@grammyjs/auto-retry';
import { Cron } from 'croner';
import { Bot } from 'grammy';
import { registerHandlers } from './bot.js';
import { type Config, holidaysOf, loadConfig } from './config.js';
import { createLogger } from './core/logger.js';
import { Desk } from './desk.js';
import { Mailer } from './mailer.js';
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
    tz: config.TIMEZONE,
    slaDays: config.SLA_DAYS,
    holidays: holidaysOf(config),
    envBindings,
  },
  log,
);

const mailer = new Mailer(
  bot.api,
  store,
  desk,
  {
    tz: config.TIMEZONE,
    teamPageUrl: config.TEAM_PAGE_URL,
    checkRemindDays: config.CHECK_REMIND_DAYS,
    checkCloseDays: config.CHECK_CLOSE_DAYS,
    sendDelayMs: 60,
  },
  log,
);

registerHandlers(bot, desk, mailer, log);

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

// Напоминания: о неотправленных заявках и о проверке страниц; итоги проверок
const reminders = new Cron('*/5 * * * *', { protect: true }, async () => {
  try {
    if (config.DRAFT_REMIND_MINUTES > 0) await desk.remindDrafts(config.DRAFT_REMIND_MINUTES);
    await mailer.tick();
  } catch (error) {
    log.error('Не удалось разослать напоминания', { error });
  }
});

await bot.api.setMyCommands(
  [
    { command: 'start', description: 'Меню' },
    { command: 'help', description: 'Как работает бот' },
  ],
  { scope: { type: 'all_private_chats' } },
);
await bot.api.setMyCommands(
  [
    { command: 'broadcast', description: 'Рассылка всем пользователям бота' },
    { command: 'pagecheck', description: 'Проверка страниц на сайте' },
    { command: 'checkstatus', description: 'Итоги проверки страниц' },
    { command: 'users', description: 'Кто пользуется ботом' },
    { command: 'id', description: 'ID чата и темы' },
  ],
  { scope: { type: 'all_group_chats' } },
);

const shutdown = async (signal: string) => {
  log.info('Остановка', { signal });
  digest?.stop();
  reminders.stop();
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

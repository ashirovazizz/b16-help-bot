import { z } from 'zod';

const optionalInt = z.preprocess(
  (v) => (v === '' || v === undefined ? undefined : v),
  z.coerce.number().int().optional(),
);
const optionalString = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
  z.string().optional(),
);

const required = (hint: string) =>
  z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string({ error: `не задано: ${hint}` }),
  );
const requiredInt = (hint: string) =>
  z.preprocess(
    (v) => (v === '' || v === undefined ? undefined : Number(v)),
    z.number({ error: `не задано или не число: ${hint}` }).int(),
  );

const schema = z
  .object({
    TELEGRAM_BOT_TOKEN: required('токен бота от @BotFather').pipe(
      z.string().min(20, 'похоже на неполный токен'),
    ),
    OPS_CHAT_ID: requiredInt('ID рабочего чата, узнать командой /id@имя_бота'),
    OPS_TOPIC_ID: optionalInt,
    ALERT_CHAT_ID: optionalInt,
    ALERT_TOPIC_ID: optionalInt,
    PUBLIC_BASE_URL: required('адрес формы, например https://forms.example.org').pipe(
      z.url('нужен полный адрес, например https://forms.example.org'),
    ),
    LINK_SECRET: required('случайная строка, openssl rand -base64 48').pipe(
      z.string().min(32, 'не короче 32 символов'),
    ),
    SITE_BASE_URL: z.url().default('https://dh.itmo.ru'),
    STORAGE: z.enum(['sheets', 'memory']).default('sheets'),
    GOOGLE_CLIENT_ID: optionalString,
    GOOGLE_CLIENT_SECRET: optionalString,
    GOOGLE_REFRESH_TOKEN: optionalString,
    SPREADSHEET_ID: optionalString,
    PHOTOS_FOLDER_ID: optionalString,
    TIMEZONE: z.string().default('Europe/Moscow'),
    PORT: z.coerce.number().int().default(3000),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    REGISTRY_SYNC_MINUTES: z.coerce.number().int().min(1).max(60).default(5),
  })
  .superRefine((c, ctx) => {
    if (c.STORAGE !== 'sheets') return;
    for (const key of [
      'GOOGLE_CLIENT_ID',
      'GOOGLE_CLIENT_SECRET',
      'GOOGLE_REFRESH_TOKEN',
      'SPREADSHEET_ID',
      'PHOTOS_FOLDER_ID',
    ] as const) {
      if (!c[key])
        ctx.addIssue({ code: 'custom', path: [key], message: 'нужно при STORAGE=sheets' });
    }
  });

export type Config = z.infer<typeof schema>;

export function loadConfig(env: Record<string, string | undefined>): Config {
  const res = schema.safeParse(env);
  if (!res.success) {
    const lines = res.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Ошибки в настройках (.env):\n${lines.join('\n')}`);
  }
  return res.data;
}

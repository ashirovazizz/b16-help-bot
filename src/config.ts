import { z } from 'zod';

const blank = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const optionalInt = z.preprocess(
  (v) => (blank(v) === undefined ? undefined : Number(v)),
  z.number({ error: 'должно быть числом' }).int().optional(),
);

const schema = z.object({
  TELEGRAM_BOT_TOKEN: z.preprocess(
    blank,
    z.string({ error: 'не задано: токен бота от @BotFather' }).min(20, 'похоже на неполный токен'),
  ),
  /** Код для /setup@бот в рабочем чате; его создаёт установщик */
  SETUP_CODE: z.preprocess(blank, z.string().min(4, 'не короче 4 символов').optional()),
  /** Можно задать тему вручную вместо /setup */
  OPS_CHAT_ID: optionalInt,
  SITE_TOPIC_ID: optionalInt,
  /** Время утренней сводки «ЧЧ:ММ» или off */
  DIGEST_TIME: z.preprocess(
    blank,
    z
      .string()
      .regex(/^(off|([01]?\d|2[0-3]):[0-5]\d)$/, 'формат ЧЧ:ММ или off')
      .default('10:00'),
  ),
  SLA_DAYS: z.preprocess(blank, z.coerce.number().int().min(1).max(30).default(3)),
  /** Праздники через запятую: 2026-11-04,2026-12-31 */
  HOLIDAYS: z.preprocess(blank, z.string().default('')),
  TIMEZONE: z.preprocess(blank, z.string().default('Europe/Moscow')),
  DATA_DIR: z.preprocess(blank, z.string().default('./data')),
  LOG_LEVEL: z.preprocess(blank, z.enum(['debug', 'info', 'warn', 'error']).default('info')),
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

export function holidaysOf(c: Config): string[] {
  return c.HOLIDAYS.split(',')
    .map((s) => s.trim())
    .filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s));
}

/**
 * Журнал в stdout в виде JSON-строк. Тексты анкет и личные данные сюда
 * не пишем — только идентификаторы заявок и людей.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, ctx?: Record<string, unknown>): void;
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
}

function serializeError(e: unknown): unknown {
  if (e instanceof Error) return { name: e.name, message: e.message, stack: e.stack };
  return e;
}

export function createLogger(level: LogLevel = 'info'): Logger {
  const min = ORDER[level];
  const write = (lvl: LogLevel, msg: string, ctx?: Record<string, unknown>) => {
    if (ORDER[lvl] < min) return;
    const entry: Record<string, unknown> = { t: new Date().toISOString(), level: lvl, msg };
    if (ctx) {
      for (const [k, v] of Object.entries(ctx)) entry[k] = k === 'error' ? serializeError(v) : v;
    }
    const line = JSON.stringify(entry);
    if (lvl === 'error' || lvl === 'warn') process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);
  };
  return {
    debug: (m, c) => write('debug', m, c),
    info: (m, c) => write('info', m, c),
    warn: (m, c) => write('warn', m, c),
    error: (m, c) => write('error', m, c),
  };
}

export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

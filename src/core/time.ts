/**
 * Время. Внутри всё хранится как Date (UTC), а в таблицу и сообщения
 * попадает местное время центра (по умолчанию Europe/Moscow).
 */

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 — воскресенье … 6 — суббота */
  weekday: number;
}

const partFormatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = partFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      weekday: 'short',
    });
    partFormatters.set(tz, f);
  }
  return f;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function zonedParts(date: Date, tz: string): ZonedParts {
  const parts: Record<string, string> = {};
  for (const p of formatterFor(tz).formatToParts(date)) parts[p.type] = p.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAYS[parts.weekday ?? ''] ?? 0,
  };
}

/** Смещение часового пояса относительно UTC в минутах для указанного момента. */
function offsetMinutes(date: Date, tz: string): number {
  const p = zonedParts(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
}

/** Местное время в поясе tz → момент UTC. */
export function zonedToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  tz: string,
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  const first = guess - offsetMinutes(new Date(guess), tz) * 60000;
  // второй проход уточняет результат рядом с переводом часов
  const refined = guess - offsetMinutes(new Date(first), tz) * 60000;
  return new Date(refined);
}

const pad = (n: number, len = 2) => String(n).padStart(len, '0');

/** «2026-09-30» — календарная дата в поясе tz. */
export function dateKey(date: Date, tz: string): string {
  const p = zonedParts(date, tz);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
}

/** «2026-09-30 14:05» — формат для таблицы. */
export function formatDateTime(date: Date, tz: string): string {
  const p = zonedParts(date, tz);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
}

/** «30.09» — короткая дата для сообщений. */
export function formatShortDate(date: Date, tz: string): string {
  const p = zonedParts(date, tz);
  return `${pad(p.day)}.${pad(p.month)}`;
}

/** «30.09.2026» */
export function formatDate(date: Date, tz: string): string {
  const p = zonedParts(date, tz);
  return `${pad(p.day)}.${pad(p.month)}.${pad(p.year, 4)}`;
}

const SHEETS_EPOCH_UTC = Date.UTC(1899, 11, 30);

/**
 * Разбирает дату из таблицы: «2026-09-30 14:05», «2026-09-30», «30.09.2026»
 * или число — серийную дату Google Таблиц (её вводят люди руками).
 */
export function parseDateTime(value: unknown, tz: string): Date | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = SHEETS_EPOCH_UTC + Math.round(value * 86400000);
    const d = new Date(ms);
    return zonedToUtc(
      d.getUTCFullYear(),
      d.getUTCMonth() + 1,
      d.getUTCDate(),
      d.getUTCHours(),
      d.getUTCMinutes(),
      0,
      tz,
    );
  }
  const s = String(value).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (m) {
    return zonedToUtc(
      Number(m[1]),
      Number(m[2]),
      Number(m[3]),
      Number(m[4] ?? 0),
      Number(m[5] ?? 0),
      Number(m[6] ?? 0),
      tz,
    );
  }
  m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s+(\d{1,2}):(\d{2}))?$/.exec(s);
  if (m) {
    return zonedToUtc(
      Number(m[3]),
      Number(m[2]),
      Number(m[1]),
      Number(m[4] ?? 0),
      Number(m[5] ?? 0),
      0,
      tz,
    );
  }
  return undefined;
}

/** Нормализует дату из таблицы к ключу «YYYY-MM-DD» (для праздников). */
export function parseDateKey(value: unknown, tz: string): string | undefined {
  const d = parseDateTime(value, tz);
  return d ? dateKey(d, tz) : undefined;
}

export const DAY_MS = 86400000;

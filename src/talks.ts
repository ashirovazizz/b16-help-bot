/**
 * Выступления сотрудников. В канале центра они почти всегда попадают
 * строкой в ежемесячные «итоги месяца», поэтому бот собирает их по месяцам
 * и выдаёт черновики таких строк. Глаголы в черновике без рода
 * («доклад», а не «выступил/выступила»): бот не знает, как писать о человеке.
 */
import { zonedParts } from './core/time.js';
import type { Ticket } from './store.js';

export const TALK_PROCESS = 'talk';

export const TALK_FORMATS = [
  'Доклад',
  'Лекция',
  'Круглый стол или дискуссия',
  'Эксперт или жюри',
  'Интервью или подкаст',
  'Другое',
] as const;

const FORMAT_WORDS: Record<string, string> = {
  Доклад: 'доклад',
  Лекция: 'лекция',
  'Круглый стол или дискуссия': 'участие в дискуссии',
  'Эксперт или жюри': 'эксперт',
  'Интервью или подкаст': 'интервью',
};

const MONTHS = [
  'январь',
  'февраль',
  'март',
  'апрель',
  'май',
  'июнь',
  'июль',
  'август',
  'сентябрь',
  'октябрь',
  'ноябрь',
  'декабрь',
];

const clean = (s: string | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

/** Черновик строки для итогов месяца. */
export function talkLine(name: string, a: Record<string, string | undefined>): string {
  const fmtRaw = clean(a.format);
  const fmt = FORMAT_WORDS[fmtRaw] ?? (fmtRaw === 'Другое' ? '' : fmtRaw.toLowerCase());
  const topic = clean(a.topic);
  const quoted =
    topic && topic.length <= 120 && !/[«"]/.test(topic)
      ? `«${topic.replace(/[.\s]+$/, '')}»`
      : topic;
  const what = [fmt, quoted].filter(Boolean).join(' ');
  let line = `${name}: ${what || 'выступление'} ${clean(a.event)}`.trim();
  if (clean(a.with)) line += `. Вместе: ${clean(a.with)}`;
  if (clean(a.link)) line += ` — ${clean(a.link)}`;
  return line;
}

const WEEKDAYS = [
  'воскресенье',
  'понедельник',
  'вторник',
  'среда',
  'четверг',
  'пятница',
  'суббота',
];
const MONTHS_GEN = [
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря',
];

/** Выступление ещё впереди: дата из ответа позже сегодняшнего дня. */
export function isUpcoming(a: Record<string, string | undefined>, now: Date, tz: string): boolean {
  const today = zonedParts(now, tz);
  const d = parseTalkDate(a.date, today.year);
  if (!d) return false;
  const key = (y: number, m: number, day: number) => y * 10_000 + m * 100 + day;
  return (
    key(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()) >
    key(today.year, today.month, today.day)
  );
}

/**
 * Черновик отдельного анонса — как анонсы лекций в канале:
 * заголовок, о чём, «Лектор — …», дата и место списком, регистрация.
 */
export function talkAnnouncement(
  name: string,
  a: Record<string, string | undefined>,
  now: Date,
  tz: string,
): string {
  const lines: string[] = [];
  const topic = clean(a.topic);
  if (topic) lines.push(topic, '');
  const fmtRaw = clean(a.format);
  const fmt = FORMAT_WORDS[fmtRaw] ?? (fmtRaw === 'Другое' ? '' : fmtRaw.toLowerCase());
  const context = `${fmt ? fmt[0]!.toUpperCase() + fmt.slice(1) : 'Выступление'} ${clean(a.event)}`;
  lines.push(`${context.trim()}.`);
  if (clean(a.about)) lines.push('', clean(a.about));
  const speaker = fmtRaw === 'Лекция' ? 'Лектор' : 'Спикер';
  const role = clean(a.role);
  lines.push('', `${speaker} — ${name}${role ? `, ${role}` : ''}.`);
  if (clean(a.with)) lines.push(`Вместе: ${clean(a.with)}.`);
  const d = parseTalkDate(a.date, zonedParts(now, tz).year);
  const when = d
    ? `${d.getUTCDate()} ${MONTHS_GEN[d.getUTCMonth()]} (${WEEKDAYS[d.getUTCDay()]})`
    : clean(a.date);
  lines.push('', `• ${[when, clean(a.time)].filter(Boolean).join(', ')}`);
  if (clean(a.place)) lines.push(`• ${clean(a.place)}`);
  if (clean(a.reg)) lines.push('', `Регистрация: ${clean(a.reg)}`);
  else if (clean(a.link)) lines.push('', `Подробности: ${clean(a.link)}`);
  return lines.join('\n');
}

/** Дата из ответа «15.10.2026», «15.10» или «2026-10-15». Год по умолчанию — год заявки. */
export function parseTalkDate(text: string | undefined, fallbackYear: number): Date | undefined {
  const s = clean(text);
  let m = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12));
  m = /(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?/.exec(s);
  if (!m) return undefined;
  let year = m[3] ? Number(m[3]) : fallbackYear;
  if (year < 100) year += 2000;
  const d = new Date(Date.UTC(year, Number(m[2]) - 1, Number(m[1]), 12));
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** Когда было выступление: по ответу, а если дату не разобрать — когда пришла заявка. */
export function talkDate(t: Ticket, tz: string): Date {
  const created = new Date(t.createdAt);
  return parseTalkDate(t.answers?.date, zonedParts(created, tz).year) ?? created;
}

/** «10», «2026-10», «10.2026» → год и месяц; пусто — текущий. */
export function parseMonth(arg: string, now: Date, tz: string): { year: number; month: number } {
  const p = zonedParts(now, tz);
  const s = arg.trim();
  if (!s) return { year: p.year, month: p.month };
  let m = /^(\d{4})-(\d{1,2})$/.exec(s);
  if (m) return check(Number(m[1]), Number(m[2]));
  m = /^(\d{1,2})(?:\.(\d{4}))?$/.exec(s);
  if (m) return check(m[2] ? Number(m[2]) : p.year, Number(m[1]));
  const byName = MONTHS.findIndex((x) => s.toLowerCase().startsWith(x.slice(0, 3)));
  if (byName >= 0) return { year: p.year, month: byName + 1 };
  throw new Error('month');

  function check(year: number, month: number) {
    if (month < 1 || month > 12) throw new Error('month');
    return { year, month };
  }
}

/** Список выступлений за месяц — готовые строки для итогов. */
export function talksDigest(
  tickets: readonly Ticket[],
  month: { year: number; month: number },
  now: Date,
  tz: string,
): string[] {
  const items = tickets
    .filter((t) => t.process === TALK_PROCESS && t.status !== 'rejected')
    .map((t) => ({ t, date: talkDate(t, tz) }))
    .filter(({ date }) => {
      const p = zonedParts(date, tz);
      return p.year === month.year && p.month === month.month;
    })
    .sort((a, b) => a.date.getTime() - b.date.getTime());
  const title = `${MONTHS[month.month - 1]} ${month.year}`;
  if (!items.length) return [`🎤 За ${title} выступлений не присылали.`];
  const past = items.filter((x) => x.date.getTime() <= now.getTime());
  const future = items.filter((x) => x.date.getTime() > now.getTime());
  const line = ({ t }: { t: Ticket }) => `• ${talkLine(t.userName, t.answers ?? {})} (№${t.id})`;
  const lines = [`🎤 Выступления за ${title}: ${items.length}. Черновики строк для итогов месяца:`];
  if (past.length) lines.push('', ...past.map(line));
  if (future.length) lines.push('', 'Ещё впереди — можно сделать анонс:', ...future.map(line));
  const chunks: string[] = [];
  let cur = '';
  for (const l of lines) {
    if (cur && cur.length + l.length + 1 > 4000) {
      chunks.push(cur);
      cur = l;
    } else cur = cur ? `${cur}\n${l}` : l;
  }
  chunks.push(cur);
  return chunks;
}

import type { WorkCalendar } from './core/calendar.js';
import { formatShortDate } from './core/time.js';
import type { ProcessDef } from './processes.js';
import { esc, messageLink } from './render.js';
import type { Ticket } from './store.js';

export interface DigestInput {
  tickets: Ticket[];
  process: ProcessDef;
  now: Date;
  calendar: WorkCalendar;
  /** Сколько рабочих дней заявка может быть в работе без пометки ⚠️ */
  slaDays: number;
}

/** Утренняя сводка по открытым заявкам процесса (HTML). Пусто — если открытых нет. */
export function buildDigest(input: DigestInput): string | undefined {
  const { now, calendar } = input;
  const fresh = input.tickets.filter((t) => t.status === 'new').sort((a, b) => a.id - b.id);
  const inWork = input.tickets.filter((t) => t.status === 'in_work').sort((a, b) => a.id - b.id);
  if (!fresh.length && !inWork.length) return undefined;

  const ref = (t: Ticket) => {
    const link = messageLink(t.chatId, t.cardId);
    return link ? `<a href="${link}">№${t.id}</a>` : `№${t.id}`;
  };
  const lines = [
    `📋 <b>${esc(input.process.title)}</b>: открытые заявки на ${formatShortDate(now, calendar.tz)}`,
  ];
  if (fresh.length) {
    lines.push('', `Никто не взял — ${fresh.length}`);
    for (const t of fresh) {
      const days = calendar.workingDaysBetween(new Date(t.createdAt), now);
      lines.push(`• ${ref(t)} ${esc(t.userName)} · ждёт ${days} р. д.${days >= 1 ? ' ⚠️' : ''}`);
    }
  }
  if (inWork.length) {
    lines.push('', `В работе — ${inWork.length}`);
    for (const t of inWork) {
      const days = calendar.workingDaysBetween(new Date(t.takenAt ?? t.createdAt), now);
      const late = days > input.slaDays ? ' ⚠️' : '';
      lines.push(
        `• ${ref(t)} ${esc(t.userName)} · ведёт ${esc(t.assigneeName ?? '—')} · ${days} р. д.${late}`,
      );
    }
  }
  return lines.join('\n');
}

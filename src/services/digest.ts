import type { WorkCalendar } from '../core/calendar.js';
import { formatShortDate } from '../core/time.js';
import { isOpen, REQUEST_TYPE_LABELS, type Request } from '../domain/model.js';
import type { PersonRow } from '../storage/repository.js';

export interface DigestInput {
  requests: Request[];
  people: PersonRow[];
  now: Date;
  calendar: WorkCalendar;
  problems?: string[];
}

const byDue = (a: Request, b: Request) =>
  (a.dueAt?.getTime() ?? Number.POSITIVE_INFINITY) -
  (b.dueAt?.getTime() ?? Number.POSITIVE_INFINITY);

/**
 * Ежедневная сводка для темы «Сайт»: что у редактора, кого ждём, что на проверке.
 * Возвращает undefined, если писать не о чем.
 */
export function buildDigest(input: DigestInput): string | undefined {
  const { now, calendar } = input;
  const tz = calendar.tz;
  const open = input.requests.filter((r) => isOpen(r.status));
  const bound = new Set(
    input.people.filter((p) => p.telegramUserId !== undefined).map((p) => p.personId),
  );

  const editor = open.filter((r) => r.status === 'with_editor').sort(byDue);
  const waiting = open
    .filter((r) => r.status === 'needs_info' || (r.status === 'draft' && r.type === 'create'))
    .sort((a, b) => a.statusSince.getTime() - b.statusSince.getTime());
  const review = open.filter((r) => r.status === 'review').sort(byDue);
  const problems = input.problems ?? [];

  if (!editor.length && !waiting.length && !review.length && !problems.length) return undefined;

  const lines: string[] = [`Сводка на ${formatShortDate(now, tz)}`];

  if (editor.length) {
    lines.push('', `У редактора — ${editor.length}`);
    for (const r of editor) {
      const late = r.dueAt && r.dueAt < now;
      const when = late
        ? `просрочено на ${Math.max(1, calendar.workingDaysBetween(r.dueAt!, now))} р. д.`
        : r.dueAt
          ? `срок ${formatShortDate(r.dueAt, tz)}`
          : '';
      const who = r.assigneeName ? `ведёт ${r.assigneeName}` : 'никто не взял';
      lines.push(
        `• ${r.requestId} ${r.fullName} · ${REQUEST_TYPE_LABELS[r.type].toLowerCase()} · ${[when, who].filter(Boolean).join(' · ')}${late ? ' ⚠️' : ''}`,
      );
    }
  }

  if (waiting.length) {
    lines.push('', `Ждём заявителей — ${waiting.length}`);
    for (const r of waiting) {
      const days = calendar.workingDaysBetween(r.statusSince, now);
      const what =
        r.status === 'needs_info' ? 'нужны данные' : 'анкета новой страницы не заполнена';
      const offline = bound.has(r.personId) ? '' : ' · не подключился к боту';
      lines.push(`• ${r.requestId} ${r.fullName} · ${what} · ${days} р. д.${offline}`);
    }
  }

  if (review.length) {
    lines.push('', `На проверке у заявителей — ${review.length}`);
    for (const r of review) {
      const due = r.dueAt ? ` · автоподтверждение после ${formatShortDate(r.dueAt, tz)}` : '';
      lines.push(`• ${r.requestId} ${r.fullName}${due}`);
    }
  }

  if (problems.length) {
    lines.push('', 'Проверьте реестр:');
    for (const p of problems) lines.push(`• ${p}`);
  }

  return lines.join('\n');
}

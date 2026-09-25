import { describe, expect, it } from 'vitest';
import { WorkCalendar } from '../src/core/calendar.js';
import { Mutex } from '../src/core/mutex.js';
import {
  dateKey,
  formatDateTime,
  formatShortDate,
  parseDateKey,
  parseDateTime,
  zonedToUtc,
} from '../src/core/time.js';
import { LinkSigner, randomCode } from '../src/core/tokens.js';

const TZ = 'Europe/Moscow';
const msk = (s: string) => parseDateTime(s, TZ)!;

describe('time', () => {
  it('переводит московское время в UTC и обратно', () => {
    const d = zonedToUtc(2026, 9, 30, 14, 5, 0, TZ);
    expect(d.toISOString()).toBe('2026-09-30T11:05:00.000Z');
    expect(formatDateTime(d, TZ)).toBe('2026-09-30 14:05');
    expect(formatShortDate(d, TZ)).toBe('30.09');
  });

  it('разбирает даты из таблицы в разных видах', () => {
    expect(formatDateTime(msk('2026-09-30 14:05'), TZ)).toBe('2026-09-30 14:05');
    expect(formatDateTime(msk('2026-09-30'), TZ)).toBe('2026-09-30 00:00');
    expect(formatDateTime(parseDateTime('30.09.2026', TZ)!, TZ)).toBe('2026-09-30 00:00');
    // серийная дата Google Таблиц: 46295 — 30.09.2026
    expect(parseDateKey(46295, TZ)).toBe('2026-09-30');
    expect(parseDateTime('', TZ)).toBeUndefined();
    expect(parseDateTime('не дата', TZ)).toBeUndefined();
  });

  it('берёт календарную дату в поясе центра, а не в UTC', () => {
    // 23:30 по Москве 30.09 — это ещё 30.09, хотя в UTC уже 20:30 того же дня
    expect(dateKey(msk('2026-09-30 23:30'), TZ)).toBe('2026-09-30');
    // 01:00 по Москве 01.10 — в UTC это ещё 30.09
    expect(dateKey(msk('2026-10-01 01:00'), TZ)).toBe('2026-10-01');
  });
});

describe('WorkCalendar', () => {
  const cal = new WorkCalendar(TZ, ['2026-11-04'], ['2026-10-31']);

  it('считает срок до конца n-го рабочего дня', () => {
    // понедельник + 3 р. д. → конец четверга
    const due = cal.addWorkingDays(msk('2026-09-28 15:00'), 3);
    expect(formatDateTime(due, TZ)).toBe('2026-10-01 23:59');
  });

  it('перескакивает выходные', () => {
    // пятница + 1 р. д. → конец понедельника
    expect(formatDateTime(cal.addWorkingDays(msk('2026-09-25 18:00'), 1), TZ)).toBe(
      '2026-09-28 23:59',
    );
    // заявка в субботу: + 2 р. д. → конец вторника
    expect(formatDateTime(cal.addWorkingDays(msk('2026-09-26 12:00'), 2), TZ)).toBe(
      '2026-09-29 23:59',
    );
  });

  it('учитывает праздники и перенесённые рабочие дни', () => {
    expect(cal.isWorkingDay(msk('2026-11-04 12:00'))).toBe(false);
    expect(cal.isWorkingDay(msk('2026-10-31 12:00'))).toBe(true); // рабочая суббота
    // вторник 03.11 + 1 р. д. → 04.11 праздник → четверг 05.11
    expect(formatDateTime(cal.addWorkingDays(msk('2026-11-03 10:00'), 1), TZ)).toBe(
      '2026-11-05 23:59',
    );
  });

  it('считает прошедшие рабочие дни', () => {
    expect(cal.workingDaysBetween(msk('2026-09-25 10:00'), msk('2026-09-28 10:00'))).toBe(1);
    expect(cal.workingDaysBetween(msk('2026-09-28 10:00'), msk('2026-10-02 10:00'))).toBe(4);
    expect(cal.workingDaysBetween(msk('2026-09-28 10:00'), msk('2026-09-28 18:00'))).toBe(0);
    expect(cal.workingDaysBetween(msk('2026-09-28 10:00'), msk('2026-09-27 10:00'))).toBe(0);
  });
});

describe('LinkSigner', () => {
  const signer = new LinkSigner('x'.repeat(40));
  const now = new Date('2026-09-28T10:00:00Z');
  const later = new Date('2026-10-10T10:00:00Z');

  it('проверяет свою подпись и роль', () => {
    const t = signer.sign('R-0007', 'requester', later);
    expect(signer.verify('R-0007', t, now)).toBe('requester');
    const e = signer.sign('R-0007', 'editor', later);
    expect(signer.verify('R-0007', e, now)).toBe('editor');
  });

  it('не пускает по ссылке от другой заявки, с другой ролью или после срока', () => {
    const t = signer.sign('R-0007', 'requester', later);
    expect(signer.verify('R-0008', t, now)).toBeNull();
    expect(signer.verify('R-0007', `e${t.slice(1)}`, now)).toBeNull();
    expect(signer.verify('R-0007', t, new Date('2026-10-11T00:00:00Z'))).toBeNull();
    expect(signer.verify('R-0007', 'мусор', now)).toBeNull();
  });

  it('не принимает подпись с другим секретом', () => {
    const other = new LinkSigner('y'.repeat(40));
    expect(signer.verify('R-0007', other.sign('R-0007', 'requester', later), now)).toBeNull();
  });

  it('требует длинный секрет', () => {
    expect(() => new LinkSigner('короткий')).toThrow();
  });

  it('делает коды приглашений, годные для deep link', () => {
    const code = randomCode();
    expect(code).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(randomCode()).not.toBe(code);
  });
});

describe('Mutex', () => {
  it('выполняет задачи строго по очереди, даже после ошибки', async () => {
    const m = new Mutex();
    const log: string[] = [];
    const slow = m.run(async () => {
      await new Promise((r) => setTimeout(r, 20));
      log.push('a');
    });
    const failing = m.run(async () => {
      log.push('b');
      throw new Error('упало');
    });
    const fast = m.run(async () => {
      log.push('c');
    });
    await slow;
    await expect(failing).rejects.toThrow('упало');
    await fast;
    expect(log).toEqual(['a', 'b', 'c']);
  });
});

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

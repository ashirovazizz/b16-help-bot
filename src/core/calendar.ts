import { DAY_MS, dateKey, zonedParts, zonedToUtc } from './time.js';

/**
 * Календарь рабочих дней: понедельник–пятница, минус праздники,
 * плюс перенесённые рабочие субботы. Праздники и переносы задаются
 * на листе Settings, так что стажёр обновляет их без программиста.
 */
export class WorkCalendar {
  private readonly holidays: Set<string>;
  private readonly workdays: Set<string>;

  constructor(
    readonly tz: string,
    holidays: Iterable<string> = [],
    workdays: Iterable<string> = [],
  ) {
    this.holidays = new Set(holidays);
    this.workdays = new Set(workdays);
  }

  isWorkingDay(date: Date): boolean {
    const key = dateKey(date, this.tz);
    if (this.workdays.has(key)) return true;
    if (this.holidays.has(key)) return false;
    const { weekday } = zonedParts(date, this.tz);
    return weekday !== 0 && weekday !== 6;
  }

  /** Полдень того же календарного дня в поясе календаря: удобная точка для шагов по дням. */
  private noonOf(date: Date): Date {
    const p = zonedParts(date, this.tz);
    return zonedToUtc(p.year, p.month, p.day, 12, 0, 0, this.tz);
  }

  private endOfDay(date: Date): Date {
    const p = zonedParts(date, this.tz);
    return zonedToUtc(p.year, p.month, p.day, 23, 59, 59, this.tz);
  }

  /**
   * Срок: конец n-го рабочего дня после даты `from`.
   * Заявка, поданная в понедельник, со сроком 3 р. д. должна быть закрыта до конца четверга.
   */
  addWorkingDays(from: Date, n: number): Date {
    let cursor = this.noonOf(from);
    let left = Math.max(0, Math.floor(n));
    if (left === 0) return this.endOfDay(cursor);
    while (left > 0) {
      cursor = new Date(cursor.getTime() + DAY_MS);
      cursor = this.noonOf(cursor);
      if (this.isWorkingDay(cursor)) left -= 1;
    }
    return this.endOfDay(cursor);
  }

  /** Сколько рабочих дней прошло после даты `from` по дату `to` включительно. */
  workingDaysBetween(from: Date, to: Date): number {
    if (to.getTime() <= from.getTime()) return 0;
    let cursor = this.noonOf(from);
    const endKey = dateKey(to, this.tz);
    let count = 0;
    while (dateKey(cursor, this.tz) < endKey) {
      cursor = this.noonOf(new Date(cursor.getTime() + DAY_MS));
      if (this.isWorkingDay(cursor)) count += 1;
    }
    return count;
  }
}

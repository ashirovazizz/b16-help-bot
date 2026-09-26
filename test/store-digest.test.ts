import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { holidaysOf, loadConfig } from '../src/config.js';
import { WorkCalendar } from '../src/core/calendar.js';
import { buildDigest } from '../src/digest.js';
import { Store, type Ticket } from '../src/store.js';
import { at, harness, ivan, OPS, TZ } from './harness.js';

const title = 'Страницы на сайте';

const ticket = (patch: Partial<Ticket>): Ticket => ({
  id: 1,
  process: 'site',
  userId: 501,
  userName: 'Иван Петров',
  status: 'new',
  createdAt: at('2026-09-28 10:00').toISOString(),
  updatedAt: at('2026-09-28 10:00').toISOString(),
  chatId: OPS,
  threadId: 77,
  cardId: 5000,
  opsMessages: [5000],
  userMessages: [],
  ...patch,
});

describe('хранилище', () => {
  it('сохраняет состояние в файл и читает его после перезапуска', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'b16-'));
    try {
      const file = path.join(dir, 'data', 'state.json');
      const a = await Store.open(file);
      await a.update((s) => {
        s.seq = 3;
        s.tickets.push(ticket({ id: 3 }));
        s.bindings.site = { chatId: OPS, threadId: 77 };
      });
      const raw = JSON.parse(await readFile(file, 'utf8'));
      expect(raw.seq).toBe(3);
      const b = await Store.open(file);
      expect(b.ticket(3)?.userName).toBe('Иван Петров');
      expect(b.state.bindings.site).toEqual({ chatId: OPS, threadId: 77 });
      expect(b.ticketByOpsMessage(OPS, 5000)?.id).toBe(3);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('номера заявок не повторяются при одновременной отправке', async () => {
    const h = harness();
    const oleg = { id: 777, is_bot: false, first_name: 'Олег' };
    await Promise.all([h.submitTicket(ivan, 'раз'), h.submitTicket(oleg, 'два')]);
    expect(h.store.state.tickets.map((t) => t.id).sort()).toEqual([1, 2]);
  });
});

describe('сводка', () => {
  const cal = new WorkCalendar(TZ);

  it('показывает новые и зависшие заявки со ссылками на карточки', () => {
    const text = buildDigest({
      tickets: [
        ticket({ id: 1 }),
        ticket({
          id: 2,
          status: 'in_work',
          assigneeName: 'Вика',
          takenAt: at('2026-09-22 10:00').toISOString(),
          cardId: 5010,
        }),
        ticket({ id: 3, status: 'done' }),
      ],
      title,
      now: at('2026-09-29 10:00'),
      calendar: cal,
      slaDays: 3,
    })!;
    expect(text).toContain('Страницы на сайте</b>: открытые заявки на 29.09');
    expect(text).toContain('Никто не взял — 1');
    expect(text).toContain(
      '<a href="https://t.me/c/1234567890/5000">№1</a> Иван Петров · изменение · ждёт 1 р. д. ⚠️',
    );
    expect(text).toContain('В работе — 1');
    expect(text).toContain('ведёт Вика · 5 р. д. ⚠️');
    expect(text).not.toContain('№3');
  });

  it('молчит, когда открытых заявок нет', () => {
    expect(
      buildDigest({
        tickets: [ticket({ status: 'done' })],
        title,
        now: new Date(),
        calendar: cal,
        slaDays: 3,
      }),
    ).toBeUndefined();
  });

  it('по выходным не присылается', async () => {
    const h = harness();
    await h.submitTicket(ivan);
    h.clock.set('2026-10-03 10:00'); // суббота
    expect(await h.desk.sendDigests()).toBe(0);
    h.clock.set('2026-10-05 10:00'); // понедельник
    expect(await h.desk.sendDigests()).toBe(1);
    expect(h.lastText(OPS)).toContain('Никто не взял — 1');
  });
});

describe('настройки', () => {
  const base = { TELEGRAM_BOT_TOKEN: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ' };

  it('хватает одного токена, остальное — по умолчанию', () => {
    const c = loadConfig({ ...base, OPS_CHAT_ID: '', HOLIDAYS: '2026-11-04, 2026-12-31, ерунда' });
    expect(c).toMatchObject({
      DIGEST_TIME: '10:00',
      SLA_DAYS: 3,
      DATA_DIR: './data',
    });
    expect(c.OPS_CHAT_ID).toBeUndefined();
    expect(holidaysOf(c)).toEqual(['2026-11-04', '2026-12-31']);
  });

  it('объясняет ошибки по-русски', () => {
    expect(() => loadConfig({})).toThrow(/TELEGRAM_BOT_TOKEN: не задано/);
    expect(() => loadConfig({ ...base, DIGEST_TIME: '25:00' })).toThrow(/ЧЧ:ММ или off/);
    expect(() => loadConfig({ ...base, OPS_CHAT_ID: 'чат' })).toThrow(/числом/);
    expect(loadConfig({ ...base, DIGEST_TIME: 'off' }).DIGEST_TIME).toBe('off');
  });
});

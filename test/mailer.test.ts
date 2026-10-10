import { describe, expect, it } from 'vitest';
import { Store } from '../src/store.js';
import { buttonsOf, harness, ivan, masha, OPS, olga, TOPIC, vika } from './harness.js';

const BOT = 'dh_test_bot';

/** Иван и Ольга открывали бота; Вика и Маша — редакторы в рабочем чате */
async function withUsers(opts: Parameters<typeof harness>[0] = {}) {
  const h = harness(opts);
  await h.handle(h.privateText(ivan, '/start'));
  await h.handle(h.privateText(olga, '/start'));
  return h;
}

const preview = (h: ReturnType<typeof harness>) =>
  h.sent('sendMessage', (p) => p.chat_id === OPS).at(-1)!;

describe('пользователи бота', () => {
  it('запоминает всех, кто пишет в личку', async () => {
    const h = await withUsers();
    expect(Object.keys(h.store.state.users).sort()).toEqual([String(ivan.id), String(olga.id)]);
    expect(h.store.state.users[ivan.id]).toMatchObject({ name: 'Иван Петров', username: 'ivan_p' });
  });

  it('/users показывает список в рабочем чате, но не вне его', async () => {
    const h = await withUsers({ blockedUsers: [olga.id] });
    await h.handle(h.groupText(vika, `/broadcast@${BOT} текст`, { thread: TOPIC }));
    await h.handle(h.callback(vika, 'o:send:1', 'ops'));
    await h.mailer.idle();

    await h.handle(h.groupText(vika, `/users@${BOT}`, { thread: TOPIC }));
    const list = h.lastText(OPS);
    expect(list).toContain('Пользователи бота: 1');
    expect(list).toContain('1. Иван Петров (@ivan_p) — с 28.09');
    expect(list).toContain('Заблокировали бота (1):\nОльга');
    expect(h.sent('sendMessage', (p) => p.chat_id === OPS).at(-1)?.payload.message_thread_id).toBe(
      TOPIC,
    );

    await h.handle(h.privateText(ivan, `/users`));
    expect(h.lastText(ivan.id)).not.toContain('Пользователи бота');
  });

  it('берёт в список всех, кто уже отправлял заявки', () => {
    const now = '2026-09-01T10:00:00.000Z';
    const store = Store.memory({
      tickets: [
        {
          id: 1,
          process: 'site',
          userId: 777,
          userName: 'Старая Заявительница',
          username: 'old_user',
          status: 'done',
          createdAt: now,
          updatedAt: now,
          chatId: OPS,
          cardId: 1,
          opsMessages: [],
          userMessages: [],
        },
      ],
    });
    expect(store.state.users['777']).toMatchObject({
      id: 777,
      name: 'Старая Заявительница',
      username: 'old_user',
    });
  });

  it('помечает тех, кто заблокировал бота', async () => {
    const h = await withUsers();
    await h.handle({
      update_id: 9999,
      my_chat_member: {
        chat: { id: ivan.id, type: 'private', first_name: ivan.first_name },
        from: ivan,
        date: 0,
        old_chat_member: { status: 'member', user: { id: 42, is_bot: true, first_name: 'DH' } },
        new_chat_member: {
          status: 'kicked',
          until_date: 0,
          user: { id: 42, is_bot: true, first_name: 'DH' },
        },
      },
    } as never);
    expect(h.store.state.users[ivan.id]?.blocked).toBe(true);
    await h.handle(h.privateText(ivan, '/start'));
    expect(h.store.state.users[ivan.id]?.blocked).toBeUndefined();
  });
});

describe('рассылка', () => {
  it('из рабочего чата: предпросмотр, подтверждение автором, отчёт', async () => {
    const h = await withUsers();
    await h.handle(
      h.groupText(vika, `/broadcast@${BOT} Завтра семинар в 18:00`, { thread: TOPIC }),
    );
    const p = preview(h);
    expect(String(p.payload.text)).toContain('получат 2 чел.');
    expect(String(p.payload.text)).toContain('Завтра семинар в 18:00');
    const [send, cancel] = buttonsOf(p.payload);
    expect(send?.callback_data).toBe('o:send:1');
    expect(cancel?.callback_data).toBe('o:cancel:1');
    // никому ничего не ушло до подтверждения
    expect(h.sent('sendMessage', (x) => x.chat_id === ivan.id)).toHaveLength(1);

    await h.handle(h.callback(masha, 'o:send:1', 'ops'));
    expect(h.answers().at(-1)).toContain('только Вика');

    await h.handle(h.callback(vika, 'o:send:1', 'ops'));
    await h.mailer.idle();
    expect(h.lastText(ivan.id)).toBe('Завтра семинар в 18:00');
    expect(h.lastText(olga.id)).toBe('Завтра семинар в 18:00');
    expect(h.lastText(OPS)).toContain('отправлена: 2 из 2');

    await h.handle(h.callback(vika, 'o:send:1', 'ops'));
    expect(h.answers().at(-1)).toBe('Уже решено');
    expect(h.sent('sendMessage', (x) => x.chat_id === ivan.id)).toHaveLength(2);
  });

  it('ответом на сообщение рассылает его копию', async () => {
    const h = await withUsers();
    await h.handle(h.groupText(vika, `/broadcast@${BOT}`, { thread: TOPIC, replyTo: 333 }));
    await h.handle(h.callback(vika, 'o:send:1', 'ops'));
    await h.mailer.idle();
    const copies = h.sent('copyMessage', (p) => p.chat_id === ivan.id);
    expect(copies[0]?.payload).toMatchObject({ from_chat_id: OPS, message_id: 333 });
  });

  it('отменяется и не запускается вне рабочего чата', async () => {
    const h = await withUsers();
    await h.handle(h.groupText(vika, `/broadcast@${BOT} текст`, { thread: TOPIC }));
    await h.handle(h.callback(vika, 'o:cancel:1', 'ops'));
    expect(h.store.state.campaigns[0]?.status).toBe('cancelled');
    expect(h.sent('sendMessage', (p) => p.chat_id === olga.id)).toHaveLength(1);

    const other = harness({ bound: false });
    await other.handle(other.privateText(ivan, '/start'));
    await other.handle(other.groupText(vika, `/broadcast@${BOT} текст`));
    expect(other.lastText(OPS)).toContain('только из рабочего чата');
  });

  it('тех, кто заблокировал бота, отмечает и показывает в отчёте', async () => {
    const h = await withUsers({ blockedUsers: [olga.id] });
    await h.handle(h.groupText(vika, `/broadcast@${BOT} текст`, { thread: TOPIC }));
    await h.handle(h.callback(vika, 'o:send:1', 'ops'));
    await h.mailer.idle();
    expect(h.lastText(OPS)).toContain('отправлена: 1 из 2');
    expect(h.lastText(OPS)).toContain('Ольга');
    expect(h.store.state.users[olga.id]?.blocked).toBe(true);
  });
});

describe('проверка страниц', () => {
  async function started(args = '') {
    const h = await withUsers();
    await h.handle(h.groupText(vika, `/pagecheck@${BOT} ${args}`.trim(), { thread: TOPIC }));
    await h.handle(h.callback(vika, 'o:send:1', 'ops'));
    await h.mailer.idle();
    return h;
  }

  it('спрашивает каждого с кнопками и собирает ответы', async () => {
    const h = await started();
    const q = h.sent('sendMessage', (p) => p.chat_id === ivan.id).at(-1)!;
    expect(String(q.payload.text)).toContain('https://dh.itmo.ru/team');
    expect(buttonsOf(q.payload).map((b) => b.callback_data)).toEqual([
      'c:ok:1',
      'c:edit:1',
      'c:new:1',
    ]);

    await h.handle(h.callback(ivan, 'c:ok:1'));
    expect(h.answers().at(-1)).toBe('Спасибо!');

    await h.handle(h.callback(olga, 'c:edit:1'));
    // «нужно изменить» сразу открывает обычную заявку
    expect(h.store.state.drafts[olga.id]?.process).toBe('site');

    await h.handle(h.groupText(vika, `/checkstatus@${BOT}`, { thread: TOPIC }));
    const status = h.lastText(OPS);
    expect(status).toContain('ответили 2 из 2');
    expect(status).toContain('✅ Всё актуально (1): Иван Петров (@ivan_p)');
    expect(status).toContain('✏️ Нужны изменения (1): Ольга');
  });

  it('«страницы нет» открывает анкету новой страницы', async () => {
    const h = await started();
    await h.handle(h.callback(ivan, 'c:new:1'));
    expect(h.store.state.drafts[ivan.id]?.process).toBe('site_new');
  });

  it('напоминает не ответившим и присылает итоги в заданные сроки', async () => {
    const h = await started('2 5');
    await h.handle(h.callback(ivan, 'c:ok:1'));

    h.clock.set('2026-09-29 10:00');
    await h.mailer.tick();
    expect(h.sent('sendMessage', (p) => p.chat_id === olga.id)).toHaveLength(2); // меню + вопрос

    h.clock.set('2026-09-30 10:01');
    await h.mailer.tick();
    const reminder = h.lastText(olga.id);
    expect(reminder).toContain('Напоминаем');
    expect(h.sent('sendMessage', (p) => p.chat_id === ivan.id)).toHaveLength(2); // ответившему нет
    expect(h.lastText(OPS)).toContain('Напомнил 1 чел.');

    h.clock.set('2026-10-03 10:01');
    await h.mailer.tick();
    expect(h.lastText(OPS)).toContain('Итоги:');
    expect(h.lastText(OPS)).toContain('Не ответили (1): Ольга');
    expect(h.store.state.campaigns[0]?.status).toBe('closed');

    h.clock.set('2026-10-10 10:01');
    const before = h.calls.length;
    await h.mailer.tick();
    expect(h.calls.length).toBe(before); // итоги один раз
  });

  it('без напоминания, если первое число 0; проверяет формат', async () => {
    const h = await started('0 4');
    h.clock.set('2026-10-01 11:00');
    await h.mailer.tick();
    expect(h.sent('sendMessage', (p) => p.chat_id === olga.id)).toHaveLength(2);

    await h.handle(h.groupText(vika, `/pagecheck@${BOT} 5 3`, { thread: TOPIC }));
    expect(h.lastText(OPS)).toContain('второе число больше первого');
  });
});

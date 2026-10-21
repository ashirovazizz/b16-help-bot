import { describe, expect, it } from 'vitest';
import { Store } from '../src/store.js';
import { buttonsOf, harness, ivan, masha, OPS, olga, TOPIC, vika } from './harness.js';

const BOT = 'dh_test_bot';
const MAIL = 99;

/** Рабочий чат с темами «Сайт» и «Рассылки»; Иван и Ольга открывали бота */
async function setup(opts: Parameters<typeof harness>[0] = {}) {
  const h = harness({
    store: Store.memory({
      bindings: { site: { chatId: OPS, threadId: TOPIC }, mail: { chatId: OPS, threadId: MAIL } },
    }),
    ...opts,
  });
  await h.handle(h.privateText(ivan, '/start'));
  await h.handle(h.privateText(olga, '/start'));
  return h;
}

type H = Awaited<ReturnType<typeof setup>>;

const inMail = (h: H) => h.sent('sendMessage', (p) => p.message_thread_id === MAIL);
const lastInMail = (h: H) => inMail(h).at(-1)!;
const press = (h: H, from = vika, data: string, messageId = 1) =>
  h.handle(h.callback(from, data, 'ops', messageId, MAIL));
const lastEdit = (h: H) => h.sent('editMessageText').at(-1)!;

describe('пользователи бота', () => {
  it('запоминает всех, кто пишет в личку', async () => {
    const h = await setup();
    expect(Object.keys(h.store.state.users).sort()).toEqual([String(ivan.id), String(olga.id)]);
    expect(h.store.state.users[ivan.id]).toMatchObject({ name: 'Иван Петров', username: 'ivan_p' });
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
    expect(store.state.users['777']).toMatchObject({ name: 'Старая Заявительница' });
  });

  it('помечает тех, кто заблокировал бота, и снимает пометку при возвращении', async () => {
    const h = await setup();
    const botUser = { id: 42, is_bot: true, first_name: 'DH' };
    await h.handle({
      update_id: 9999,
      my_chat_member: {
        chat: { id: ivan.id, type: 'private', first_name: ivan.first_name },
        from: ivan,
        date: 0,
        old_chat_member: { status: 'member', user: botUser },
        new_chat_member: { status: 'kicked', until_date: 0, user: botUser },
      },
    } as never);
    expect(h.store.state.users[ivan.id]?.blocked).toBe(true);
    await h.handle(h.privateText(ivan, '/start'));
    expect(h.store.state.users[ivan.id]?.blocked).toBeUndefined();
  });
});

describe('панель в теме «Рассылки»', () => {
  it('появляется после /setup … mail и открывает список получателей на месте', async () => {
    const h = harness({ setupCode: 'secret-42' });
    await h.handle(h.privateText(ivan, '/start'));
    await h.handle(h.groupText(vika, `/setup@${BOT} secret-42 mail`, { thread: MAIL }));
    const panel = lastInMail(h);
    expect(String(panel.payload.text)).toContain('Получателей: 1');
    const buttons = buttonsOf(panel.payload);
    expect(buttons.map((b) => b.text)).toEqual([
      '🔎 Проверка страниц',
      '👥 Получатели',
      '📊 Итоги проверки',
      '🔄 Обновить',
    ]);
    const panelId = h.store.state.mailPanel!.messageId;

    await h.handle(h.callback(vika, buttons[1]!.callback_data!, 'ops', panelId, MAIL));
    const edit = lastEdit(h);
    expect(edit.payload.message_id).toBe(panelId);
    expect(String(edit.payload.text)).toContain('1. Иван Петров (@ivan_p)');
    expect(buttonsOf(edit.payload).map((b) => b.text)).toContain('← Назад');
    // новых сообщений в теме не появилось
    expect(inMail(h)).toHaveLength(1);
  });

  it('с неверным кодом панель не появляется', async () => {
    const h = await setup();
    await h.handle(h.groupText(vika, `/setup@${BOT} неверный mail`, { thread: MAIL }));
    expect(h.lastText(OPS)).toContain('Код не подошёл');
    expect(h.store.state.mailPanel).toBeUndefined();
  });

  it('/mail ставит панель заново и убирает старую; вне темы подсказывает', async () => {
    const h = await setup();
    await h.handle(h.groupText(vika, `/mail@${BOT}`, { thread: MAIL }));
    const first = h.store.state.mailPanel!.messageId;
    await h.handle(h.groupText(vika, `/mail@${BOT}`, { thread: MAIL }));
    expect(h.store.state.mailPanel!.messageId).not.toBe(first);
    expect(h.sent('deleteMessage', (p) => p.message_id === first)).toHaveLength(1);

    await h.handle(h.groupText(vika, `/mail@${BOT}`, { thread: TOPIC }));
    expect(h.lastText(OPS)).toContain('в теме «Рассылки»');
  });
});

describe('рассылка', () => {
  it('сообщение в теме → предпросмотр → «Отправить» автором → отчёт в том же сообщении', async () => {
    const h = await setup();
    await h.handle(h.groupText(vika, 'Завтра семинар в 18:00', { thread: MAIL }));
    const source = h.calls.length; // ничего никому не ушло
    const preview = lastInMail(h);
    expect(String(preview.payload.text)).toBe('Разослать это сообщение? Получат 2 чел.');
    expect(buttonsOf(preview.payload).map((b) => b.callback_data)).toEqual([
      'o:send:1',
      'o:cancel:1',
    ]);
    expect(h.sent('copyMessage')).toHaveLength(0);
    expect(source).toBeGreaterThan(0);

    const previewId = h.store.state.campaigns[0]!.previewId!;
    await press(h, masha, 'o:send:1', previewId);
    expect(h.answers().at(-1)).toContain('решает автор');

    await press(h, vika, 'o:send:1', previewId);
    await h.mailer.idle();
    const copies = h.sent('copyMessage');
    expect(copies.map((c) => c.payload.chat_id).sort()).toEqual([ivan.id, olga.id].sort());
    const report = lastEdit(h);
    expect(report.payload.message_id).toBe(previewId);
    expect(String(report.payload.text)).toBe('✅ Разослано: 2 из 2.');
    expect(inMail(h)).toHaveLength(1); // только предпросмотр, ставший отчётом

    await press(h, vika, 'o:send:1', previewId);
    expect(h.answers().at(-1)).toBe('Уже решено');
    expect(h.sent('copyMessage')).toHaveLength(2);
  });

  it('«Отменить» стирает предпросмотр и само сообщение', async () => {
    const h = await setup();
    await h.handle(h.groupText(vika, 'опечатка', { thread: MAIL }));
    const c = h.store.state.campaigns[0]!;
    await press(h, vika, 'o:cancel:1', c.previewId);
    const deleted = h.sent('deleteMessage').map((d) => d.payload.message_id);
    expect(deleted).toEqual(expect.arrayContaining([c.previewId, c.source!.messageId]));
    expect(h.store.state.campaigns[0]!.status).toBe('cancelled');
  });

  it('не реагирует на команды, ответы на сообщения бота и другие темы', async () => {
    const h = await setup();
    await h.handle(h.groupText(vika, '/id', { thread: MAIL }));
    await h.handle(h.groupText(vika, 'уточнение', { thread: MAIL, replyTo: 5000 }));
    await h.handle(h.groupText(vika, 'обычный разговор', { thread: TOPIC }));
    expect(h.store.state.campaigns).toHaveLength(0);
    // ответ коллеге в теме рассылок — это новое сообщение для рассылки
    await h.handle(h.groupText(vika, 'текст', { thread: MAIL, replyTo: 3, replyToUser: true }));
    expect(h.store.state.campaigns).toHaveLength(1);
  });

  it('альбом — одна рассылка пачкой', async () => {
    const h = await setup();
    await h.handle(h.groupText(vika, 'фото 1', { thread: MAIL, photo: true, album: 'g1' }));
    await h.handle(h.groupText(vika, '', { thread: MAIL, photo: true, album: 'g1' }));
    expect(h.store.state.campaigns).toHaveLength(1);
    const c = h.store.state.campaigns[0]!;
    expect(c.source!.messageIds).toHaveLength(2);
    await press(h, vika, 'o:send:1', c.previewId);
    await h.mailer.idle();
    expect(h.sent('copyMessages', (p) => p.chat_id === ivan.id)[0]?.payload.message_ids).toEqual(
      c.source!.messageIds,
    );
  });

  it('заблокировавших отмечает и называет в отчёте', async () => {
    const h = await setup({ blockedUsers: [olga.id] });
    await h.handle(h.groupText(vika, 'текст', { thread: MAIL }));
    await press(h, vika, 'o:send:1', h.store.state.campaigns[0]!.previewId);
    await h.mailer.idle();
    expect(String(lastEdit(h).payload.text)).toContain('Разослано: 1 из 2');
    expect(String(lastEdit(h).payload.text)).toContain('Ольга');
    expect(h.store.state.users[olga.id]?.blocked).toBe(true);
  });

  it('неподтверждённый предпросмотр через час убирается', async () => {
    const h = await setup();
    await h.handle(h.groupText(vika, 'передумала', { thread: MAIL }));
    const c = h.store.state.campaigns[0]!;
    h.clock.set('2026-09-28 11:01');
    await h.mailer.tick();
    expect(h.store.state.campaigns[0]!.status).toBe('cancelled');
    expect(h.sent('deleteMessage', (p) => p.message_id === c.previewId)).toHaveLength(1);
    expect(h.sent('deleteMessage', (p) => p.message_id === c.source!.messageId)).toHaveLength(0);
  });
});

describe('проверка страниц', () => {
  async function started(h: H) {
    await h.handle(h.groupText(vika, `/mail@${BOT}`, { thread: MAIL }));
    const panel = h.sent('sendMessage', (p) => p.message_thread_id === MAIL).at(-1)!;
    const checkBtn = buttonsOf(panel.payload)[0]!.callback_data!;
    await press(h, vika, checkBtn, h.store.state.mailPanel!.messageId);
    return h.store.state.campaigns.at(-1)!;
  }

  it('сроки меняются кнопками в предпросмотре, вопрос уходит всем', async () => {
    const h = await setup();
    const c = await started(h);
    const preview = lastInMail(h);
    expect(String(preview.payload.text)).toContain('вопрос получат 2 чел.');
    expect(buttonsOf(preview.payload).map((b) => b.text)).toEqual([
      '⏰ Напомнить: через 3 дня',
      '📊 Итоги: через 7 дней',
      '📣 Отправить (2)',
      '✖️ Отменить',
    ]);

    await press(h, vika, `o:remind:${c.id}`, c.previewId);
    expect(buttonsOf(lastEdit(h).payload)[0]!.text).toBe('⏰ Напомнить: через 5 дней');
    await press(h, vika, `o:remind:${c.id}`, c.previewId); // 7 — итоги сдвигаются на 10
    expect(buttonsOf(lastEdit(h).payload)[1]!.text).toBe('📊 Итоги: через 10 дней');
    await press(h, vika, `o:remind:${c.id}`, c.previewId); // по кругу — без напоминания
    expect(buttonsOf(lastEdit(h).payload)[0]!.text).toBe('⏰ Без напоминания');

    await press(h, vika, `o:send:${c.id}`, c.previewId);
    await h.mailer.idle();
    const q = h.sent('sendMessage', (p) => p.chat_id === ivan.id).at(-1)!;
    expect(String(q.payload.text)).toContain('https://dh.itmo.ru/team');
    expect(buttonsOf(q.payload).map((b) => b.callback_data)).toEqual([
      `c:ok:${c.id}`,
      `c:edit:${c.id}`,
      `c:new:${c.id}`,
    ]);
    // предпросмотр стал сводкой с кнопкой обновления
    expect(String(lastEdit(h).payload.text)).toContain('ответили 0 из 2');
    expect(buttonsOf(lastEdit(h).payload).map((b) => b.callback_data)).toEqual([`o:stat:${c.id}`]);
  });

  it('собирает ответы, напоминает молчащим и присылает итоги', async () => {
    const h = await setup();
    const c = await started(h); // по умолчанию: напоминание через 3 дня, итоги через 7
    await press(h, vika, `o:send:${c.id}`, c.previewId);
    await h.mailer.idle();

    await h.handle(h.callback(ivan, `c:ok:${c.id}`));
    expect(h.answers().at(-1)).toBe('Спасибо!');
    await press(h, masha, `o:stat:${c.id}`, c.previewId);
    expect(String(lastEdit(h).payload.text)).toContain(
      '✅ Всё актуально (1): Иван Петров (@ivan_p)',
    );

    h.clock.set('2026-10-01 10:01');
    await h.mailer.tick();
    expect(h.lastText(olga.id)).toContain('Напоминаем');
    expect(h.sent('sendMessage', (p) => p.chat_id === ivan.id)).toHaveLength(2); // меню + вопрос

    await h.handle(h.callback(olga, `c:edit:${c.id}`));
    expect(h.store.state.drafts[olga.id]?.process).toBe('site');

    h.clock.set('2026-10-05 10:01');
    await h.mailer.tick();
    const results = lastInMail(h);
    expect(String(results.payload.text)).toContain('📊 Итоги проверки страниц');
    expect(String(results.payload.text)).toContain('✏️ Нужны изменения (1): Ольга');
    expect(h.store.state.campaigns.at(-1)!.status).toBe('closed');

    const before = h.calls.length;
    h.clock.set('2026-10-10 10:01');
    await h.mailer.tick();
    expect(h.calls.length).toBe(before);
  });

  it('«Страницы нет» открывает анкету новой страницы', async () => {
    const h = await setup();
    const c = await started(h);
    await press(h, vika, `o:send:${c.id}`, c.previewId);
    await h.mailer.idle();
    await h.handle(h.callback(ivan, `c:new:${c.id}`));
    expect(h.store.state.drafts[ivan.id]?.process).toBe('site_new');
  });
});

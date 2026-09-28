import { describe, expect, it } from 'vitest';
import { buttonsOf, harness, ivan, masha, OPS, olga, stranger, TOPIC, vika } from './harness.js';

describe('настройка', () => {
  it('без выбранной темы бот честно говорит, что не настроен', async () => {
    const h = harness({ bound: false });
    await h.handle(h.privateText(ivan, '/start'));
    expect(h.lastText(ivan.id)).toContain('ещё не настроен');
  });

  it('в новой группе подсказывает команду /setup', async () => {
    const h = harness({ bound: false });
    await h.handle(h.addedToGroup(vika));
    expect(h.lastText(OPS)).toContain('/setup@dh_test_bot КОД');
  });

  it('/id показывает ID чата и темы', async () => {
    const h = harness();
    await h.handle(h.groupText(vika, '/id@dh_test_bot', { thread: TOPIC }));
    expect(h.lastText(OPS)).toBe(`chat_id: ${OPS}\ntopic_id: ${TOPIC}`);
  });

  it('/setup с верным кодом привязывает тему, с неверным — нет', async () => {
    const h = harness({ bound: false });
    await h.handle(h.groupText(vika, '/setup@dh_test_bot 0000', { thread: TOPIC }));
    expect(h.lastText(OPS)).toContain('Код не подошёл');
    expect(h.store.state.bindings.site).toBeUndefined();

    await h.handle(h.groupText(vika, '/setup@dh_test_bot secret-42', { thread: TOPIC }));
    expect(h.lastText(OPS)).toContain('Готово');
    expect(h.store.state.bindings.site).toEqual({ chatId: OPS, threadId: TOPIC });

    await h.handle(h.privateText(ivan, '/setup secret-42'));
    expect(h.lastText(ivan.id)).toContain('в рабочем чате');
  });

  it('без кода в .env настройка командой выключена', async () => {
    const h = harness({ bound: false, setupCode: null });
    await h.handle(h.groupText(vika, '/setup@dh_test_bot secret-42', { thread: TOPIC }));
    expect(h.lastText(OPS)).toContain('выключена');
  });
});

describe('доступ', () => {
  it('ботом пользуется любой, кто ему написал, без проверки чатов', async () => {
    const h = harness();
    await h.handle(h.privateText(stranger, '/start'));
    const menu = h.sent('sendMessage', (p) => p.chat_id === stranger.id).at(-1)!;
    expect(menu.payload.text).toBe(
      'Здравствуйте, Кто-то!\n\n' +
        'Я передаю ваши заявки коллегам по дх-центру, ответственным за разные направления, а ответы оттуда — вам.\n\n' +
        'Выберите, с чем нужна помощь, опишите задачу одним или несколькими сообщениями и нажмите «Отправить заявку». ' +
        'Когда редактор ответит, сообщение придёт сюда; чтобы ответить, просто напишите в этот чат.',
    );
    expect(buttonsOf(menu.payload).map((b) => b.callback_data)).toEqual([
      'p:site',
      'p:site_new',
      'm:list',
    ]);
    expect(h.sent('getChatMember')).toHaveLength(0);

    const id = await h.submitTicket(stranger, 'хочу страницу');
    expect(h.store.ticket(id)).toMatchObject({ userId: stranger.id, status: 'new' });
  });
});

describe('заявка', () => {
  it('собирается из нескольких сообщений и уходит карточкой в тему', async () => {
    const h = harness();
    await h.handle(h.callback(ivan, 'p:site'));
    const intro = h.sent('sendMessage', (p) => p.chat_id === ivan.id).at(-1)!;
    expect(buttonsOf(intro.payload).map((b) => b.callback_data)).toEqual(['d:send', 'd:cancel']);

    await h.handle(h.privateText(ivan, 'Новая подпись: исследователь медиа'));
    await h.handle(h.privatePhoto(ivan, 'новое фото'));
    expect(h.sent('setMessageReaction', (p) => p.chat_id === ivan.id)).toHaveLength(2);
    expect(h.store.state.drafts[ivan.id]?.messages).toHaveLength(2);

    await h.handle(h.callback(ivan, 'd:send'));
    const card = h.sent('sendMessage', (p) => p.chat_id === OPS)[0]!;
    expect(card.payload.message_thread_id).toBe(TOPIC);
    expect(card.payload.parse_mode).toBe('HTML');
    expect(String(card.payload.text)).toContain('<b>Заявка №1</b> · Изменение страницы на сайте');
    expect(String(card.payload.text)).toContain('Иван Петров');
    expect(buttonsOf(card.payload).map((b) => b.callback_data)).toEqual([
      't:take:1',
      't:done:1',
      't:reject:1',
    ]);

    const copy = h.sent('copyMessages')[0]!;
    expect(copy.payload).toMatchObject({
      chat_id: OPS,
      from_chat_id: ivan.id,
      message_thread_id: TOPIC,
    });
    expect(copy.payload.message_ids).toEqual([100, 101]);

    expect(h.lastText(ivan.id)).toContain('Заявка №1 отправлена');
    expect(h.store.state.drafts[ivan.id]).toBeUndefined();
    expect(h.store.state.tickets[0]).toMatchObject({ id: 1, status: 'new', userId: ivan.id });
    expect(h.store.state.tickets[0]!.opsMessages).toHaveLength(3); // карточка + 2 копии
  });

  it('пустую заявку не отправляет, отмену принимает', async () => {
    const h = harness();
    await h.handle(h.callback(ivan, 'p:site'));
    await h.handle(h.callback(ivan, 'd:send'));
    expect(h.answers().at(-1)).toContain('хотя бы одно сообщение');
    await h.handle(h.callback(ivan, 'd:cancel'));
    expect(h.store.state.drafts[ivan.id]).toBeUndefined();
    expect(h.sent('sendMessage', (p) => p.chat_id === OPS)).toHaveLength(0);
  });

  it('если Telegram не копирует пачкой, копирует по одному', async () => {
    const h = harness({ failCopyMessages: true });
    await h.submitTicket(ivan);
    expect(h.sent('copyMessage', (p) => p.chat_id === OPS)).toHaveLength(1);
    expect(h.store.state.tickets[0]!.opsMessages).toHaveLength(2);
  });

  it('«Мои заявки» показывает статусы', async () => {
    const h = harness();
    await h.submitTicket(ivan);
    await h.handle(h.callback(ivan, 'm:list'));
    expect(h.lastText(ivan.id)).toMatch(/№1 · Изменение страницы на сайте · 🆕 новая/);
  });
});

describe('редактор', () => {
  it('«Беру», «Готово», «Вернуть» меняют карточку и уведомляют заявителя', async () => {
    const h = harness();
    const id = await h.submitTicket(ivan);

    await h.handle(h.callback(vika, `t:take:${id}`, 'ops'));
    let card = h.sent('editMessageText', (p) => p.chat_id === OPS).at(-1)!;
    expect(String(card.payload.text)).toContain('🛠 в работе · Вика');
    expect(buttonsOf(card.payload).map((b) => b.callback_data)).toEqual([
      `t:done:${id}`,
      `t:reject:${id}`,
    ]);
    expect(h.lastText(ivan.id)).toContain('в работе, ведёт Вика');

    await h.handle(h.callback(masha, `t:take:${id}`, 'ops'));
    expect(h.answers().at(-1)).toBe('Заявку уже ведёт Вика.');

    await h.handle(h.callback(vika, `t:done:${id}`, 'ops'));
    expect(h.lastText(ivan.id)).toContain('выполнена');
    card = h.sent('editMessageText', (p) => p.chat_id === OPS).at(-1)!;
    expect(buttonsOf(card.payload).map((b) => b.callback_data)).toEqual([`t:reopen:${id}`]);

    await h.handle(h.callback(vika, `t:done:${id}`, 'ops'));
    expect(h.answers().at(-1)).toContain('Уже сделано');

    await h.handle(h.callback(masha, `t:reopen:${id}`, 'ops'));
    expect(h.store.ticket(id)).toMatchObject({ status: 'in_work', assigneeName: 'Вика' });
    expect(h.lastText(ivan.id)).toContain('вернули в работу');
  });

  it('можно сразу нажать «Готово» или «Отклонить», не беря заявку', async () => {
    const h = harness();
    const id = await h.submitTicket(ivan);
    await h.handle(h.callback(vika, `t:reject:${id}`, 'ops'));
    expect(h.store.ticket(id)).toMatchObject({ status: 'rejected', assigneeName: 'Вика' });
    expect(h.lastText(ivan.id)).toContain('отклонена');
  });

  it('кнопки карточек вне рабочего чата не работают', async () => {
    const h = harness();
    const id = await h.submitTicket(ivan);
    await h.handle(h.callback(ivan, `t:done:${id}`, 'private'));
    expect(h.store.ticket(id)?.status).toBe('new');
  });
});

describe('переписка по заявке', () => {
  it('ответ редактора на карточку уходит заявителю, ответ заявителя — в ветку', async () => {
    const h = harness();
    const id = await h.submitTicket(ivan);
    const t = h.store.ticket(id)!;

    await h.handle(
      h.groupText(vika, 'Пришлите фото без очков?', { replyTo: t.cardId, thread: TOPIC }),
    );
    expect(h.lastText(ivan.id)).toBe(`💬 Вика · заявка №${id}\nПришлите фото без очков?`);
    expect(h.sent('setMessageReaction', (p) => p.chat_id === OPS)).toHaveLength(1);

    await h.handle(h.privateText(ivan, 'Сейчас пришлю'));
    const toOps = h.sent('sendMessage', (p) => p.chat_id === OPS).at(-1)!;
    expect(toOps.payload.text).toBe(`💬 Иван Петров · заявка №${id}\nСейчас пришлю`);
    expect(toOps.payload.message_thread_id).toBe(TOPIC);
    expect(toOps.payload.reply_parameters).toMatchObject({ message_id: t.cardId });

    await h.handle(h.privatePhoto(ivan, 'вот'));
    const photo = h.sent('copyMessage', (p) => p.chat_id === OPS).at(-1)!;
    expect(photo.payload.caption).toBe(`💬 Иван Петров · заявка №${id}\nвот`);

    // редактор отвечает уже на пересланное сообщение — тоже доходит
    const relayed = h.store.ticket(id)!.opsMessages.at(-1)!;
    await h.handle(h.groupText(vika, 'Спасибо!', { replyTo: relayed, thread: TOPIC }));
    expect(h.lastText(ivan.id)).toContain('Спасибо!');
  });

  it('ответ на чужое сообщение бота в чате не пересылается', async () => {
    const h = harness();
    await h.submitTicket(ivan);
    const before = h.sent('sendMessage', (p) => p.chat_id === ivan.id).length;
    await h.handle(h.groupText(vika, 'это не про заявку', { replyTo: 99999, thread: TOPIC }));
    expect(h.sent('sendMessage', (p) => p.chat_id === ivan.id)).toHaveLength(before);
  });

  it('без ответа сообщение уходит в заявку, где последняя переписка', async () => {
    const h = harness();
    const first = await h.submitTicket(ivan, 'первая');
    h.clock.set('2026-09-28 10:05');
    const second = await h.submitTicket(ivan, 'вторая');
    h.clock.set('2026-09-28 10:10');
    await h.handle(h.privateText(ivan, 'ко второй'));
    expect(h.lastText(OPS)).toContain(`заявка №${second}`);

    h.clock.set('2026-09-28 10:15');
    const noteOfFirst = h.store.ticket(first)!.userMessages[0]!;
    await h.handle(h.privateText(ivan, 'к первой', noteOfFirst));
    expect(h.lastText(OPS)).toContain(`заявка №${first}`);
    h.clock.set('2026-09-28 10:20');
    await h.handle(h.privateText(ivan, 'и ещё к первой'));
    expect(h.lastText(OPS)).toContain(`заявка №${first}`);
  });

  it('ответ на сообщение по заявке уходит в неё, даже если открыт черновик', async () => {
    const h = harness();
    const first = await h.submitTicket(ivan, 'первая');
    const noteOfFirst = h.store.ticket(first)!.userMessages[0]!;
    await h.handle(h.callback(ivan, 'p:site')); // начал вторую
    await h.handle(h.privateText(ivan, 'уточнение к первой', noteOfFirst));
    expect(h.lastText(OPS)).toContain(`заявка №${first}`);
    expect(h.store.state.drafts[ivan.id]?.messages).toHaveLength(0);
    await h.handle(h.privateText(ivan, 'а это уже в черновик'));
    expect(h.store.state.drafts[ivan.id]?.messages).toHaveLength(1);
  });

  it('без открытых заявок сообщение показывает меню', async () => {
    const h = harness();
    await h.handle(h.privateText(olga, 'привет'));
    expect(h.lastText(olga.id)).toContain('Выберите, что нужно сделать');
  });

  it('после закрытия переписка продолжается с пометкой', async () => {
    const h = harness();
    const id = await h.submitTicket(ivan);
    await h.handle(h.callback(vika, `t:done:${id}`, 'ops'));
    const done = h.store.ticket(id)!.userMessages.at(-1)!;
    await h.handle(h.privateText(ivan, 'опечатка в подписи', done));
    expect(h.lastText(OPS)).toContain(`заявка №${id} (закрыта)`);
  });
});

describe('ошибки', () => {
  it('непредвиденная ошибка — тревога и вежливый ответ', async () => {
    const h = harness();
    h.desk.startDraft = async () => {
      throw new Error('диск переполнен');
    };
    await h.handle(h.callback(ivan, 'p:site'));
    expect(h.alerts[0]).toContain('диск переполнен');
    expect(h.answers().at(-1)).toContain('пошло не так');
  });
});

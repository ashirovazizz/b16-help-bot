import { describe, expect, it } from 'vitest';
import { buttonsOf, harness, ivan, OPS, TOPIC, vika } from './harness.js';

type H = ReturnType<typeof harness>;

const lastToUser = (h: H) => h.sent('sendMessage', (p) => p.chat_id === ivan.id).at(-1)!;

/** Заполняет анкету новой страницы; необязательные вопросы пропускает. */
async function fillNewPage(h: H) {
  await h.handle(h.callback(ivan, 'p:site_new'));
  await h.handle(h.privateText(ivan, 'Иван Петров'));
  await h.handle(h.privateText(ivan, 'исследователь медиа'));
  await h.handle(h.privateText(ivan, 'Изучаю <интернет> & медиа.\n\nВторой абзац.'));
  await h.handle(h.callback(ivan, 'd:skip')); // проекты
  await h.handle(h.privateText(ivan, 'Цифровые методы'));
  await h.handle(h.callback(ivan, 'd:skip')); // контакты
  await h.handle(h.privateDocument(ivan, 'image/jpeg', 'me.jpg'));
}

describe('новая страница через анкету', () => {
  it('в меню есть «Создать страницу на сайте»', async () => {
    const h = harness();
    await h.handle(h.privateText(ivan, '/start'));
    const labels = buttonsOf(lastToUser(h).payload).map((b) => b.text);
    expect(labels).toEqual([
      '✏️ Изменить мою страницу',
      '🆕 Создать страницу на сайте',
      '📋 Мои заявки',
    ]);
  });

  it('задаёт вопросы по очереди: обязательные нельзя пропустить', async () => {
    const h = harness();
    await h.handle(h.callback(ivan, 'p:site_new'));
    const q1 = lastToUser(h);
    expect(String(q1.payload.text)).toMatch(/^1\/7\. Как подписать вас на сайте/);
    expect(buttonsOf(q1.payload).map((b) => b.callback_data)).toEqual(['d:cancel']);

    await h.handle(h.callback(ivan, 'd:skip'));
    expect(h.answers().at(-1)).toContain('обязательный');

    await h.handle(h.privatePhoto(ivan));
    expect(String(lastToUser(h).payload.text)).toContain('нужен текст');

    await h.handle(h.privateText(ivan, 'Иван Петров'));
    expect(String(lastToUser(h).payload.text)).toMatch(/^2\/7\. Коротко, кто вы в центре/);
    expect(h.sent('editMessageReplyMarkup', (p) => p.chat_id === ivan.id).length).toBeGreaterThan(
      0,
    );

    await h.handle(h.privateText(ivan, 'исследователь медиа'));
    await h.handle(h.privateText(ivan, 'О себе'));
    const q4 = lastToUser(h);
    expect(String(q4.payload.text)).toContain('(можно пропустить)');
    expect(buttonsOf(q4.payload).map((b) => b.callback_data)).toEqual(['d:skip', 'd:cancel']);
  });

  it('на вопрос про фото принимает только картинку', async () => {
    const h = harness();
    await h.handle(h.callback(ivan, 'p:site_new'));
    for (const text of ['Иван Петров', 'подпись', 'о себе']) {
      await h.handle(h.privateText(ivan, text));
    }
    for (let i = 0; i < 3; i++) await h.handle(h.callback(ivan, 'd:skip'));
    await h.handle(h.privateText(ivan, 'фото потом'));
    expect(String(lastToUser(h).payload.text)).toContain('Пришлите фото');
    await h.handle(h.privateDocument(ivan, 'application/pdf', 'cv.pdf'));
    expect(String(lastToUser(h).payload.text)).toContain('Пришлите фото');
    await h.handle(h.privatePhoto(ivan));
    expect(String(lastToUser(h).payload.text)).toContain('Анкета заполнена');
  });

  it('показывает итог, а редактор получает карточку, анкету и фото', async () => {
    const h = harness();
    await fillNewPage(h);
    const summary = lastToUser(h);
    expect(String(summary.payload.text)).toContain('• Имя на сайте: Иван Петров');
    expect(String(summary.payload.text)).toContain('• Проекты и исследования: —');
    expect(String(summary.payload.text)).toContain('• Фото: ✓ есть');
    expect(buttonsOf(summary.payload).map((b) => b.callback_data)).toEqual([
      'd:send',
      'd:restart',
      'd:cancel',
    ]);

    await h.handle(h.callback(ivan, 'd:send'));
    const toOps = h.sent('sendMessage', (p) => p.chat_id === OPS);
    expect(String(toOps[0]!.payload.text)).toContain(
      '🆕 <b>Заявка №1</b> · Новая страница на сайте',
    );
    const form = toOps[1]!.payload;
    expect(form.parse_mode).toBe('HTML');
    expect(form.message_thread_id).toBe(TOPIC);
    expect(String(form.text)).toBe(
      [
        '<b>Имя на сайте</b>\nИван Петров',
        '<b>Подпись</b>\nисследователь медиа',
        '<b>О себе</b>\nИзучаю &lt;интернет&gt; &amp; медиа.\n\nВторой абзац.',
        '<b>Проекты и исследования</b>\n—',
        '<b>Курсы</b>\nЦифровые методы',
        '<b>Контакты</b>\n—',
      ].join('\n\n'),
    );
    const photo = h.sent('copyMessage', (p) => p.chat_id === OPS).at(-1)!.payload;
    expect(photo).toMatchObject({ from_chat_id: ivan.id, caption: 'Фото для страницы' });

    const t = h.store.ticket(1)!;
    expect(t.process).toBe('site_new');
    expect(t.opsMessages).toHaveLength(3); // карточка, анкета, фото
    expect(h.store.state.drafts[ivan.id]).toBeUndefined();
    expect(h.lastText(ivan.id)).toContain('Заявка №1 отправлена');
  });

  it('до конца анкеты отправить нельзя, «Заполнить заново» начинает сначала', async () => {
    const h = harness();
    await h.handle(h.callback(ivan, 'p:site_new'));
    await h.handle(h.privateText(ivan, 'Иван Петров'));
    await h.handle(h.callback(ivan, 'd:send'));
    expect(h.answers().at(-1)).toContain('ответьте на все вопросы');

    await fillNewPage(h);
    await h.handle(h.callback(ivan, 'd:restart'));
    expect(h.store.state.drafts[ivan.id]).toMatchObject({ step: 0, answers: {} });
    expect(String(lastToUser(h).payload.text)).toMatch(/^1\/7\./);
  });

  it('ответ редактора на анкету уходит заявителю', async () => {
    const h = harness();
    await fillNewPage(h);
    await h.handle(h.callback(ivan, 'd:send'));
    const formId = h.store.ticket(1)!.opsMessages[1]!;
    await h.handle(
      h.groupText(vika, 'Добавьте, пожалуйста, почту', { replyTo: formId, thread: TOPIC }),
    );
    expect(h.lastText(ivan.id)).toBe('💬 Вика · заявка №1\nДобавьте, пожалуйста, почту');
  });

  it('сводка отличает новую страницу от изменения', async () => {
    const h = harness();
    await fillNewPage(h);
    await h.handle(h.callback(ivan, 'd:send'));
    await h.desk.sendDigests();
    expect(h.lastText(OPS)).toContain('Иван Петров · новая страница · ждёт 0 р. д.');
  });
});

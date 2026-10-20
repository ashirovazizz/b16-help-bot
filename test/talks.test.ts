import { describe, expect, it } from 'vitest';
import { Store } from '../src/store.js';
import { isUpcoming, parseMonth, talkLine } from '../src/talks.js';
import { at, buttonsOf, harness, ivan, OPS, TOPIC, TZ, vika } from './harness.js';

const TALKS_TOPIC = 88;
const BOT = 'dh_test_bot';

function withTalks() {
  return harness({
    store: Store.memory({
      bindings: {
        site: { chatId: OPS, threadId: TOPIC },
        talks: { chatId: OPS, threadId: TALKS_TOPIC },
      },
    }),
  });
}

type H = ReturnType<typeof withTalks>;

/** Ответы по порядку; null — «пропустить», число — кнопка варианта */
async function fill(h: H, answers: (string | number | null)[]) {
  await h.handle(h.callback(ivan, 'p:talk'));
  for (const a of answers) {
    if (a === null) await h.handle(h.callback(ivan, 'd:skip'));
    else if (typeof a === 'number') await h.handle(h.callback(ivan, `d:pick:${a}`));
    else await h.handle(h.privateText(ivan, a));
  }
}

const inTalks = (h: H) => h.sent('sendMessage', (p) => p.message_thread_id === TALKS_TOPIC);

describe('выступления', () => {
  it('прошедшее: короткая анкета, карточка в теме «Выступления» и строка для итогов', async () => {
    const h = withTalks();
    await h.handle(h.privateText(ivan, '/start'));
    const menu = h.sent('sendMessage', (p) => p.chat_id === ivan.id).at(-1)!;
    expect(buttonsOf(menu.payload).map((b) => b.text)).toContain('🎤 Рассказать о выступлении');

    await h.handle(h.callback(ivan, 'p:talk'));
    await h.handle(h.privateText(ivan, 'на форуме «Радикальная стабильность» в ГЭС-2'));
    await h.handle(h.privateText(ivan, '12.09.2026'));
    const formatQ = h.sent('sendMessage', (p) => p.chat_id === ivan.id).at(-1)!;
    // для прошедшего выступления вопросов анонса нет: 3-й из 7
    expect(String(formatQ.payload.text)).toMatch(/^3\/7\. Что это было/);
    expect(buttonsOf(formatQ.payload).map((b) => b.callback_data)).toContain('d:pick:0');
    await h.handle(h.callback(ivan, 'd:pick:0')); // Доклад
    await h.handle(h.privateText(ivan, 'Медиа и стабильность'));
    await h.handle(h.privateText(ivan, 'Артём Тарасов'));
    await h.handle(h.privateText(ivan, 'https://ges-2.org/x'));
    await h.handle(h.callback(ivan, 'd:skip')); // без фото
    expect(h.lastText(ivan.id)).toContain('Формат: Доклад');
    await h.handle(h.callback(ivan, 'd:send'));

    const card = inTalks(h)[0]!;
    expect(String(card.payload.text)).toContain('Выступление');
    const note = String(inTalks(h).at(-1)!.payload.text);
    expect(note).toBe(
      '📝 Черновик для итогов месяца:\nИван Петров: доклад «Медиа и стабильность» на форуме «Радикальная стабильность» в ГЭС-2. Вместе: Артём Тарасов — https://ges-2.org/x',
    );
    expect(h.store.state.tickets[0]!.answers).toMatchObject({
      format: 'Доклад',
      date: '12.09.2026',
    });
  });

  it('будущее: дополнительные вопросы и черновик анонса', async () => {
    const h = withTalks(); // «сегодня» 28.09.2026
    await fill(h, [
      'в Медиахолле Центральной библиотеки',
      '28.10.2026',
      1, // Лекция
      'Бережная цифровизация',
      'Как технологии становятся культурой и наоборот.',
      'исследовательница DH-центра',
      '19:00–20:30',
      'Наб. р. Фонтанки, 44',
      'https://timepad.ru/e/1',
      null,
      null,
      null,
    ]);
    await h.handle(h.callback(ivan, 'd:send'));
    const note = String(inTalks(h).at(-1)!.payload.text);
    expect(note).toContain('📣 Черновик анонса:');
    expect(note).toContain('Бережная цифровизация\n\nЛекция в Медиахолле Центральной библиотеки.');
    expect(note).toContain('Лектор — Иван Петров, исследовательница DH-центра.');
    expect(note).toContain('• 28 октября (среда), 19:00–20:30\n• Наб. р. Фонтанки, 44');
    expect(note).toContain('Регистрация: https://timepad.ru/e/1');
  });

  it('/talks собирает выступления месяца, будущие — отдельно', async () => {
    const h = withTalks();
    await fill(h, ['на конференции «А»', '15.09.2026', 0, 'Тема А', null, null, null]);
    await h.handle(h.callback(ivan, 'd:send'));
    await fill(h, [
      'в Шанинке',
      '30.09.2026',
      3,
      'Тема Б',
      'о чём',
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
    await h.handle(h.callback(ivan, 'd:send'));
    await fill(h, ['на семинаре', '02.08.2026', 1, 'Тема В', null, null, null]);
    await h.handle(h.callback(ivan, 'd:send'));

    await h.handle(h.groupText(vika, `/talks@${BOT}`, { thread: TALKS_TOPIC }));
    const list = h.lastText(OPS);
    expect(list).toContain('Выступления за сентябрь 2026: 2');
    expect(list).toContain('• Иван Петров: доклад «Тема А» на конференции «А» (№1)');
    expect(list).toContain(
      'Ещё впереди — можно сделать анонс:\n• Иван Петров: эксперт «Тема Б» в Шанинке (№2)',
    );
    expect(list).not.toContain('Тема В');

    await h.handle(h.groupText(vika, `/talks@${BOT} 2026-08`, { thread: TALKS_TOPIC }));
    expect(h.lastText(OPS)).toContain('Тема В');
    await h.handle(h.groupText(vika, `/talks@${BOT} 13`, { thread: TALKS_TOPIC }));
    expect(h.lastText(OPS)).toContain('Укажите месяц');
  });

  it('без темы «Выступления» кнопки в меню нет', async () => {
    const h = harness();
    await h.handle(h.privateText(ivan, '/start'));
    const menu = h.sent('sendMessage', (p) => p.chat_id === ivan.id).at(-1)!;
    expect(buttonsOf(menu.payload).map((b) => b.text)).not.toContain('🎤 Рассказать о выступлении');
  });
});

describe('разбор дат и строк', () => {
  const now = at('2026-09-28 10:00');
  it('понимает разные записи даты и месяца', () => {
    expect(isUpcoming({ date: '29.09' }, now, TZ)).toBe(true);
    expect(isUpcoming({ date: '28.09.2026' }, now, TZ)).toBe(false);
    expect(isUpcoming({ date: 'на прошлой неделе' }, now, TZ)).toBe(false);
    expect(parseMonth('', now, TZ)).toEqual({ year: 2026, month: 9 });
    expect(parseMonth('октябрь', now, TZ)).toEqual({ year: 2026, month: 10 });
    expect(parseMonth('11.2025', now, TZ)).toEqual({ year: 2025, month: 11 });
  });
  it('не берёт тему в кавычки повторно и обходится без формата', () => {
    expect(talkLine('Оля', { event: 'в эфире', format: 'Другое', topic: '«Уже в кавычках»' })).toBe(
      'Оля: «Уже в кавычках» в эфире',
    );
  });
});

import { Bot } from 'grammy';
import type { Update, User, UserFromGetMe } from 'grammy/types';
import { describe, expect, it } from 'vitest';
import { silentLogger } from '../src/core/logger.js';
import { LinkSigner } from '../src/core/tokens.js';
import { MemoryPhotoStore } from '../src/photos/memory.js';
import { Links } from '../src/services/links.js';
import { RequestService } from '../src/services/service.js';
import { MemoryRepository } from '../src/storage/memory.js';
import { registerHandlers } from '../src/telegram/bot.js';
import { TelegramNotifier } from '../src/telegram/notifier.js';
import { at, FakeSite, fakePng, people, profiles, TestClock, TZ } from './helpers.js';

const OPS = -1001234567890;
const TOPIC = 77;

const botInfo: UserFromGetMe = {
  id: 42,
  is_bot: true,
  first_name: 'DH',
  username: 'dh_test_bot',
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};

const aziz: User = { id: 501, is_bot: false, first_name: 'Азиз', last_name: 'Аширов' };
const vika: User = { id: 900, is_bot: false, first_name: 'Вика', username: 'vika' };
const masha: User = { id: 901, is_bot: false, first_name: 'Маша' };
const stranger: User = { id: 12345, is_bot: false, first_name: 'Кто-то' };

interface Call {
  method: string;
  payload: Record<string, unknown>;
}

function harness(opts: { people?: ConstructorParameters<typeof MemoryRepository>[0] } = {}) {
  const clock = new TestClock(at('2026-09-28 10:00'));
  const repo = new MemoryRepository(
    opts.people ?? {
      people: [people.aziz, people.masha, people.newbie],
      profiles: [profiles.aziz!, profiles.masha!],
    },
  );
  const bot = new Bot('000:test', { botInfo });
  const calls: Call[] = [];
  const alerts: string[] = [];
  let nextId = 5000;
  bot.api.config.use(async (_prev, method, payload) => {
    const p = (payload ?? {}) as Record<string, unknown>;
    calls.push({ method, payload: p });
    let result: unknown = true;
    if (method === 'sendMessage' || method === 'sendDocument') {
      result = {
        message_id: nextId++,
        date: 0,
        chat: { id: p.chat_id, type: 'supergroup' },
        text: p.text ?? '',
      };
    }
    // biome-ignore lint/suspicious/noExplicitAny: подделка ответа Telegram
    return { ok: true, result } as any;
  });
  const notifier = new TelegramNotifier(bot.api, { chatId: OPS, topicId: TOPIC });
  const service = new RequestService({
    repo,
    notifier,
    photos: new MemoryPhotoStore(),
    links: new Links(new LinkSigner('s'.repeat(40)), 'https://forms.example.org', clock),
    clock,
    tz: TZ,
    log: silentLogger,
    site: new FakeSite(),
    settingsTtlMs: 0,
  });
  registerHandlers(
    bot,
    {
      opsChatId: OPS,
      alert: async (t) => {
        alerts.push(t);
      },
    },
    service,
    silentLogger,
  );

  let updateId = 1;
  const privateText = (from: User, text: string): Update => {
    const cmd = /^\/\S+/.exec(text)?.[0];
    return {
      update_id: updateId++,
      message: {
        message_id: updateId,
        date: 0,
        chat: { id: from.id, type: 'private', first_name: from.first_name },
        from,
        text,
        ...(cmd ? { entities: [{ type: 'bot_command', offset: 0, length: cmd.length }] } : {}),
      },
    };
  };
  const callback = (
    from: User,
    data: string,
    chat: { id: number; type: 'private' | 'supergroup' } = { id: from.id, type: 'private' },
    messageId = 1,
  ): Update =>
    ({
      update_id: updateId++,
      callback_query: {
        id: `cb${updateId}`,
        from,
        chat_instance: 'ci',
        data,
        message: {
          message_id: messageId,
          date: 0,
          chat:
            chat.type === 'private'
              ? { ...chat, first_name: from.first_name }
              : { ...chat, title: 'DH' },
          ...(chat.type === 'supergroup'
            ? { message_thread_id: TOPIC, is_topic_message: true }
            : {}),
          text: 'карточка',
        },
      },
    }) as unknown as Update;
  const groupReply = (
    from: User,
    text: string,
    replyTo: { message_id: number; text: string },
  ): Update =>
    ({
      update_id: updateId++,
      message: {
        message_id: updateId,
        date: 0,
        chat: { id: OPS, type: 'supergroup', title: 'DH', is_forum: true },
        message_thread_id: TOPIC,
        is_topic_message: true,
        from,
        text,
        reply_to_message: {
          message_id: replyTo.message_id,
          date: 0,
          chat: { id: OPS, type: 'supergroup', title: 'DH' },
          from: botInfo,
          text: replyTo.text,
        },
      },
    }) as unknown as Update;

  // как при long polling: ошибки уходят в bot.catch
  const handle = (u: Update) => bot.handleUpdate(u).catch((err) => bot.errorHandler(err));
  const sent = (method: string, filter: (p: Record<string, unknown>) => boolean = () => true) =>
    calls.filter((c) => c.method === method && filter(c.payload));
  const lastPrompt = () => {
    const idx = calls.findLastIndex(
      (c) =>
        c.method === 'sendMessage' &&
        c.payload.chat_id === OPS &&
        (c.payload.reply_markup as { force_reply?: boolean } | undefined)?.force_reply === true,
    );
    const call = calls[idx]!;
    // id выданного сообщения: считаем по порядку sendMessage/sendDocument
    const order = calls
      .slice(0, idx + 1)
      .filter((c) => c.method === 'sendMessage' || c.method === 'sendDocument').length;
    return {
      message_id: 5000 + order - 1,
      text: String(call.payload.text).replace(/<[^>]+>/g, ''),
    };
  };

  return {
    bot,
    calls,
    alerts,
    service,
    repo,
    clock,
    handle,
    privateText,
    callback,
    groupReply,
    sent,
    lastPrompt,
  };
}

const buttonsOf = (p: Record<string, unknown>) =>
  (
    (
      p.reply_markup as {
        inline_keyboard?: { text: string; url?: string; callback_data?: string }[][];
      }
    )?.inline_keyboard ?? []
  ).flat();

describe('Telegram: личка', () => {
  it('незнакомцу предлагает попросить приглашение', async () => {
    const h = harness();
    await h.handle(h.privateText(stranger, '/start'));
    expect(String(h.sent('sendMessage')[0]?.payload.text)).toContain('ссылку-приглашение');
  });

  it('привязка по ссылке и анкета новой страницы', async () => {
    const h = harness();
    await h.service.syncRegistry();
    const code = h.repo.people.find((p) => p.personId === 'P003')!.inviteCode!;
    const newbie: User = { id: 777, is_bot: false, first_name: 'Новый', username: 'newbie' };
    await h.handle(h.privateText(newbie, `/start ${code}`));
    const msgs = h.sent('sendMessage', (p) => p.chat_id === 777);
    expect(String(msgs[0]?.payload.text)).toContain('бот вас узнал');
    const form = buttonsOf(msgs[1]!.payload).find((b) => b.url);
    expect(form?.url).toMatch(/^https:\/\/forms\.example\.org\/r\/R-\d+\?t=r/);
    expect(h.repo.people.find((p) => p.personId === 'P003')?.telegramUsername).toBe('newbie');
  });

  it('кнопка «Обновить» присылает форму, свободный текст — меню', async () => {
    const h = harness();
    await h.handle(h.callback(aziz, 'm:update'));
    const msg = h.sent('sendMessage', (p) => p.chat_id === aziz.id).at(-1)!;
    expect(buttonsOf(msg.payload)[0]?.url).toContain('/r/R-0001?t=');
    await h.handle(h.privateText(aziz, 'привет'));
    expect(String(h.sent('sendMessage').at(-1)?.payload.text)).toContain('только кнопки');
  });

  it('ушедшему сотруднику кнопки не работают', async () => {
    const h = harness();
    h.repo.people.find((p) => p.personId === 'P001')!.status = 'left';
    await h.handle(h.callback(aziz, 'm:update'));
    const answer = h.sent('answerCallbackQuery').at(-1)!;
    expect(answer.payload.show_alert).toBe(true);
    expect(String(answer.payload.text)).toContain('Доступ закрыт');
  });
});

describe('Telegram: тема «Сайт»', () => {
  async function submitted(h: ReturnType<typeof harness>) {
    const start = await h.service.startUpdate(aziz.id);
    await h.service.submitForm(start.request.requestId, {
      fields: { about: 'Новый текст' },
      photo: fakePng(),
    });
    return start.request.requestId;
  }

  it('карточка приходит в тему с кнопками, фото — в ветку карточки', async () => {
    const h = harness();
    const id = await submitted(h);
    const card = h.sent('sendMessage', (p) => p.chat_id === OPS)[0]!;
    expect(card.payload.message_thread_id).toBe(TOPIC);
    expect(card.payload.parse_mode).toBe('HTML');
    expect(String(card.payload.text)).toContain(`<b>${id} · Обновление</b>`);
    expect(String(card.payload.text)).toContain('Изменено: О себе, Фото');
    const data = buttonsOf(card.payload).map((b) => b.callback_data ?? b.url);
    expect(data).toEqual(
      expect.arrayContaining([`e:take:${id}`, `e:info:${id}`, `e:pub:${id}`, `e:rej:${id}`]),
    );
    expect(buttonsOf(card.payload).some((b) => b.url?.includes('?t=e'))).toBe(true);
    const doc = h.sent('sendDocument')[0]!;
    expect(doc.payload.reply_parameters).toMatchObject({ message_id: 5000 });
  });

  it('«Беру» закрепляет заявку, другой редактор получает отказ', async () => {
    const h = harness();
    const id = await submitted(h);
    await h.handle(h.callback(vika, `e:take:${id}`, { id: OPS, type: 'supergroup' }, 5000));
    const edited = h.sent('editMessageText').at(-1)!;
    expect(String(edited.payload.text)).toContain('Ведёт: Вика');
    expect(buttonsOf(edited.payload).some((b) => b.callback_data?.startsWith('e:take'))).toBe(
      false,
    );

    await h.handle(h.callback(masha, `e:pub:${id}`, { id: OPS, type: 'supergroup' }, 5000));
    const answer = h.sent('answerCallbackQuery').at(-1)!;
    expect(answer.payload.text).toContain('ведёт Вика');
    expect((await h.repo.getRequest(id))?.status).toBe('with_editor');
  });

  it('кнопки карточки вне рабочего чата игнорируются', async () => {
    const h = harness();
    const id = await submitted(h);
    await h.handle(h.callback(vika, `e:pub:${id}`));
    expect((await h.repo.getRequest(id))?.status).toBe('with_editor');
  });

  it('«Нужны данные»: подсказка, ответ редактора уходит заявителю', async () => {
    const h = harness();
    const id = await submitted(h);
    await h.handle(h.callback(vika, `e:info:${id}`, { id: OPS, type: 'supergroup' }, 5000));
    const prompt = h.lastPrompt();
    expect(prompt.text).toContain(`Вопрос заявителю по ${id}`);
    await h.handle(h.groupReply(vika, 'Пришлите фото без очков', prompt));
    expect((await h.repo.getRequest(id))?.status).toBe('needs_info');
    const dm = h.sent('sendMessage', (p) => p.chat_id === aziz.id).at(-1)!;
    expect(String(dm.payload.text)).toContain('Пришлите фото без очков');
    expect(h.sent('deleteMessage').at(-1)?.payload.message_id).toBe(prompt.message_id);
  });

  it('публикация, подтверждение заявителем, закрытие', async () => {
    const h = harness();
    const id = await submitted(h);
    await h.handle(h.callback(vika, `e:pub:${id}`, { id: OPS, type: 'supergroup' }, 5000));
    expect((await h.repo.getRequest(id))?.status).toBe('review');
    const dm = h.sent('sendMessage', (p) => p.chat_id === aziz.id).at(-1)!;
    expect(buttonsOf(dm.payload).map((b) => b.callback_data)).toEqual([
      `c:ok:${id}`,
      `c:fix:${id}`,
    ]);

    await h.handle(h.callback(aziz, `c:ok:${id}`));
    expect((await h.repo.getRequest(id))?.status).toBe('done');
    expect(h.repo.profiles.find((p) => p.personId === 'P001')?.fields.about).toBe('Новый текст');
  });

  it('новая страница: бот спрашивает адрес и принимает только ссылку', async () => {
    const h = harness({
      people: { people: [{ ...people.newbie, telegramUserId: 777 }], profiles: [] },
    });
    await h.service.syncRegistry();
    const draft = h.repo.requests[0]!;
    await h.service.submitForm(draft.requestId, {
      fields: { title: 'преподаватель', about: 'О себе' },
      photo: fakePng(),
    });
    await h.handle(
      h.callback(vika, `e:pub:${draft.requestId}`, { id: OPS, type: 'supergroup' }, 5000),
    );
    const prompt = h.lastPrompt();
    expect(prompt.text).toContain('Адрес новой страницы');
    await h.handle(h.groupReply(vika, 'страница готова', prompt));
    expect(String(h.sent('sendMessage').at(-1)?.payload.text)).toContain('ссылку целиком');
    await h.handle(h.groupReply(vika, 'вот: https://dh.itmo.ru/newbie', prompt));
    const r = await h.repo.getRequest(draft.requestId);
    expect(r?.status).toBe('review');
    expect(r?.pageUrl).toBe('https://dh.itmo.ru/newbie');
  });

  it('/id показывает ID чата и темы для настройки', async () => {
    const h = harness();
    await h.handle({
      update_id: 999,
      message: {
        message_id: 1,
        date: 0,
        chat: { id: OPS, type: 'supergroup', title: 'DH', is_forum: true },
        message_thread_id: TOPIC,
        is_topic_message: true,
        from: vika,
        text: '/id@dh_test_bot',
        entities: [{ type: 'bot_command', offset: 0, length: 15 }],
      },
    } as Update);
    const reply = h.sent('sendMessage').at(-1)!;
    expect(reply.payload.text).toBe(`chat_id: ${OPS}\ntopic_id: ${TOPIC}`);
    expect(reply.payload.message_thread_id).toBe(TOPIC);
  });

  it('непредвиденная ошибка: тревога и вежливый ответ', async () => {
    const h = harness();
    h.repo.listPeople = async () => {
      throw new Error('Sheets недоступен');
    };
    await h.handle(h.callback(aziz, 'm:update'));
    expect(h.alerts[0]).toContain('Sheets недоступен');
    expect(String(h.sent('answerCallbackQuery').at(-1)?.payload.text)).toContain('пошло не так');
  });
});

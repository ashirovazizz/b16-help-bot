import { Bot } from 'grammy';
import type { Update, User, UserFromGetMe } from 'grammy/types';
import { registerHandlers } from '../src/bot.js';
import { silentLogger } from '../src/core/logger.js';
import { type Clock, parseDateTime } from '../src/core/time.js';
import { Desk, type DeskConfig } from '../src/desk.js';
import { Store } from '../src/store.js';

export const TZ = 'Europe/Moscow';
export const OPS = -1001234567890;
export const TOPIC = 77;
export const at = (s: string) => parseDateTime(s, TZ)!;

export const botInfo: UserFromGetMe = {
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

export const ivan: User = {
  id: 501,
  is_bot: false,
  first_name: 'Иван',
  last_name: 'Петров',
  username: 'ivan_p',
};
export const olga: User = { id: 502, is_bot: false, first_name: 'Ольга' };
export const vika: User = { id: 900, is_bot: false, first_name: 'Вика' };
export const masha: User = { id: 901, is_bot: false, first_name: 'Маша' };
export const stranger: User = { id: 12345, is_bot: false, first_name: 'Кто-то' };

export class TestClock implements Clock {
  constructor(public current: Date) {}
  now() {
    return new Date(this.current);
  }
  set(s: string) {
    this.current = at(s);
  }
}

export interface Call {
  method: string;
  payload: Record<string, unknown>;
}

export interface HarnessOptions {
  bound?: boolean;
  access?: DeskConfig['access'];
  /** Статусы участников рабочего чата; остальных Telegram считает вышедшими */
  members?: Record<number, string>;
  memberCheckFails?: boolean;
  failCopyMessages?: boolean;
  store?: Store;
  setupCode?: string | null;
}

export function harness(opts: HarnessOptions = {}) {
  const bot = new Bot('000:test', { botInfo });
  const calls: Call[] = [];
  const alerts: string[] = [];
  let nextId = 5000;
  const members = opts.members ?? {
    [ivan.id]: 'member',
    [olga.id]: 'member',
    [vika.id]: 'administrator',
  };

  bot.api.config.use(async (_prev, method, payload) => {
    const p = (payload ?? {}) as Record<string, unknown>;
    calls.push({ method, payload: p });
    let result: unknown = true;
    if (method === 'sendMessage') {
      result = {
        message_id: nextId++,
        date: 0,
        chat: { id: p.chat_id, type: 'private' },
        text: p.text,
      };
    } else if (method === 'copyMessage') {
      result = { message_id: nextId++ };
    } else if (method === 'copyMessages') {
      if (opts.failCopyMessages) {
        return {
          ok: false,
          error_code: 400,
          description: 'Bad Request: message can not be copied',
        } as never;
      }
      result = (p.message_ids as number[]).map(() => ({ message_id: nextId++ }));
    } else if (method === 'getChatMember') {
      if (opts.memberCheckFails) {
        return {
          ok: false,
          error_code: 400,
          description: 'Bad Request: member list is inaccessible',
        } as never;
      }
      const status = members[p.user_id as number] ?? 'left';
      result = { status, user: { id: p.user_id, is_bot: false, first_name: 'x' } };
    }
    return { ok: true, result } as never;
  });

  const store =
    opts.store ??
    Store.memory(
      opts.bound === false ? {} : { bindings: { site: { chatId: OPS, threadId: TOPIC } } },
    );
  const clock = new TestClock(at('2026-09-28 10:00'));
  const setupCode = opts.setupCode === undefined ? 'secret-42' : opts.setupCode;
  const desk = new Desk(
    bot.api,
    store,
    {
      ...(setupCode ? { setupCode } : {}),
      access: opts.access ?? 'chat_members',
      tz: TZ,
      slaDays: 3,
      holidays: [],
      envBindings: {},
    },
    silentLogger,
    clock,
  );
  registerHandlers(bot, desk, silentLogger, {
    alert: async (t) => {
      alerts.push(t);
    },
  });

  let updateId = 1;
  let msgId = 100;
  const entities = (text: string) => {
    const cmd = /^\/\S+/.exec(text)?.[0];
    return cmd
      ? { entities: [{ type: 'bot_command' as const, offset: 0, length: cmd.length }] }
      : {};
  };
  const privateChat = (from: User) => ({
    id: from.id,
    type: 'private' as const,
    first_name: from.first_name,
  });
  const groupChat = { id: OPS, type: 'supergroup' as const, title: 'DH', is_forum: true as const };

  const u = {
    privateText(from: User, text: string, replyTo?: number): Update {
      return {
        update_id: updateId++,
        message: {
          message_id: msgId++,
          date: 0,
          chat: privateChat(from),
          from,
          text,
          ...entities(text),
          ...(replyTo !== undefined
            ? {
                reply_to_message: {
                  message_id: replyTo,
                  date: 0,
                  chat: privateChat(from),
                  from: botInfo,
                  text: '…',
                },
              }
            : {}),
        },
      } as unknown as Update;
    },
    privatePhoto(from: User, caption?: string): Update {
      return {
        update_id: updateId++,
        message: {
          message_id: msgId++,
          date: 0,
          chat: privateChat(from),
          from,
          photo: [{ file_id: 'f', file_unique_id: 'u', width: 800, height: 1000 }],
          ...(caption ? { caption } : {}),
        },
      } as unknown as Update;
    },
    callback(from: User, data: string, chat: 'private' | 'ops' = 'private', messageId = 1): Update {
      const c = chat === 'private' ? privateChat(from) : groupChat;
      return {
        update_id: updateId++,
        callback_query: {
          id: `cb${updateId}`,
          from,
          chat_instance: 'ci',
          data,
          message: {
            message_id: messageId,
            date: 0,
            chat: c,
            ...(chat === 'ops' ? { message_thread_id: TOPIC, is_topic_message: true } : {}),
            text: '…',
          },
        },
      } as unknown as Update;
    },
    groupText(
      from: User,
      text: string,
      opts2: { replyTo?: number; thread?: number; photo?: boolean } = {},
    ): Update {
      return {
        update_id: updateId++,
        message: {
          message_id: msgId++,
          date: 0,
          chat: groupChat,
          ...(opts2.thread !== undefined
            ? { message_thread_id: opts2.thread, is_topic_message: true }
            : {}),
          from,
          ...(opts2.photo
            ? {
                photo: [{ file_id: 'f', file_unique_id: 'u', width: 800, height: 1000 }],
                caption: text,
              }
            : { text, ...entities(text) }),
          ...(opts2.replyTo !== undefined
            ? {
                reply_to_message: {
                  message_id: opts2.replyTo,
                  date: 0,
                  chat: groupChat,
                  from: botInfo,
                  text: '…',
                },
              }
            : {}),
        },
      } as unknown as Update;
    },
    addedToGroup(by: User): Update {
      return {
        update_id: updateId++,
        my_chat_member: {
          chat: groupChat,
          from: by,
          date: 0,
          old_chat_member: { status: 'left', user: botInfo },
          new_chat_member: { status: 'member', user: botInfo },
        },
      } as unknown as Update;
    },
  };

  // как при long polling: ошибки уходят в bot.catch
  const handle = (update: Update) => bot.handleUpdate(update).catch((err) => bot.errorHandler(err));
  const sent = (method: string, filter: (p: Record<string, unknown>) => boolean = () => true) =>
    calls.filter((c) => c.method === method && filter(c.payload));
  const lastText = (chatId: number) =>
    String(sent('sendMessage', (p) => p.chat_id === chatId).at(-1)?.payload.text ?? '');
  const answers = () => sent('answerCallbackQuery').map((c) => String(c.payload.text ?? ''));

  /** Сотрудник собирает и отправляет заявку; возвращает её номер */
  async function submitTicket(from: User, text = 'Поменяйте подпись на «исследователь медиа»') {
    await handle(u.callback(from, 'p:site'));
    await handle(u.privateText(from, text));
    await handle(u.callback(from, 'd:send'));
    return store.state.seq;
  }

  return {
    bot,
    calls,
    alerts,
    store,
    desk,
    clock,
    handle,
    sent,
    lastText,
    answers,
    submitTicket,
    ...u,
  };
}

export const buttonsOf = (p: Record<string, unknown>) =>
  (
    (p.reply_markup as { inline_keyboard?: { text: string; callback_data?: string }[][] })
      ?.inline_keyboard ?? []
  ).flat();

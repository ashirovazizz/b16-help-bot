import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Mutex } from './core/mutex.js';

export type Status = 'new' | 'in_work' | 'done' | 'rejected';

export const OPEN_STATUSES: ReadonlySet<Status> = new Set(['new', 'in_work']);

export interface Ticket {
  id: number;
  process: string;
  /** Telegram ID заявителя — он же ID личного чата с ботом */
  userId: number;
  userName: string;
  username?: string;
  status: Status;
  assigneeId?: number;
  assigneeName?: string;
  createdAt: string;
  updatedAt: string;
  takenAt?: string;
  closedAt?: string;
  /** Куда ушла заявка: рабочий чат и тема */
  chatId: number;
  threadId?: number;
  /** Карточка заявки в рабочем чате */
  cardId: number;
  /** Сообщения бота в рабочем чате по этой заявке: ответ на любое уходит заявителю */
  opsMessages: number[];
  /** Сообщения бота в личке заявителя по этой заявке */
  userMessages: number[];
}

/** Ответ на вопрос анкеты. */
export interface Answer {
  text?: string;
  messageId: number;
}

/** Заявка, которую сотрудник ещё собирает. */
export interface Draft {
  process: string;
  /** Свободная заявка: сообщения сотрудника */
  messages: number[];
  /** Последнее сообщение бота с кнопками черновика */
  promptId?: number;
  /** Свободная заявка: подсказка «ещё не отправлено» под последним сообщением */
  statusId?: number;
  startedAt: string;
  /** Когда сотрудник последний раз что-то добавил */
  lastAt?: string;
  /** Напоминание о неотправленной заявке уже было */
  reminded?: boolean;
  /** Анкета: номер текущего вопроса и ответы */
  step?: number;
  answers?: Record<string, Answer>;
}

/** Кто хоть раз писал боту в личку: только им бот может написать сам. */
export interface BotUser {
  id: number;
  name: string;
  username?: string;
  firstAt: string;
  lastAt: string;
  /** Пользователь заблокировал бота: рассылки до него не дойдут */
  blocked?: boolean;
}

/** Ответ на проверку страниц. */
export type CheckAnswer = 'ok' | 'edit' | 'new';

/** Рассылка из рабочего чата: обычное сообщение или проверка страниц. */
export interface Campaign {
  id: number;
  kind: 'broadcast' | 'check';
  /** Откуда запустили: сюда же приходят отчёт и итоги */
  chatId: number;
  threadId?: number;
  authorId: number;
  authorName: string;
  createdAt: string;
  status: 'preview' | 'sending' | 'sent' | 'cancelled' | 'closed';
  /** Сообщение с предпросмотром и кнопками */
  previewId?: number;
  /** Текст рассылки или сообщение рабочего чата, которое разошлём копией */
  text?: string;
  source?: { chatId: number; messageId: number };
  /** Проверка: через сколько дней напомнить и подвести итоги */
  remindDays?: number;
  closeDays?: number;
  sentAt?: string;
  remindedAt?: string;
  closedAt?: string;
  delivered?: number[];
  failed?: number[];
  answers?: Record<string, { answer: CheckAnswer; at: string }>;
}

/** Куда падают заявки группы процессов. */
export interface Binding {
  chatId: number;
  threadId?: number;
}

export interface State {
  version: 1;
  seq: number;
  tickets: Ticket[];
  drafts: Record<string, Draft>;
  bindings: Record<string, Binding>;
  users: Record<string, BotUser>;
  campaignSeq: number;
  campaigns: Campaign[];
}

const emptyState = (): State => ({
  version: 1,
  seq: 0,
  tickets: [],
  drafts: {},
  bindings: {},
  users: {},
  campaignSeq: 0,
  campaigns: [],
});

/** Все, кто уже отправлял заявки, — тоже пользователи бота (список появился позже заявок). */
function withUsersFromTickets(s: State): State {
  for (const t of s.tickets) {
    const key = String(t.userId);
    if (s.users[key]) continue;
    s.users[key] = {
      id: t.userId,
      name: t.userName,
      ...(t.username ? { username: t.username } : {}),
      firstAt: t.createdAt,
      lastAt: t.updatedAt,
    };
  }
  return s;
}

/**
 * Состояние бота в одном JSON-файле. Заявок немного, базе данных тут
 * делать нечего. Запись атомарная: сначала во временный файл, потом rename.
 */
export class Store {
  private readonly lock = new Mutex();

  private constructor(
    private readonly file: string | undefined,
    private s: State,
  ) {}

  static async open(file: string): Promise<Store> {
    try {
      const raw = await readFile(file, 'utf8');
      const saved = JSON.parse(raw) as Partial<State>;
      return new Store(file, withUsersFromTickets({ ...emptyState(), ...saved }));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      await mkdir(path.dirname(file), { recursive: true });
      return new Store(file, emptyState());
    }
  }

  static memory(init: Partial<State> = {}): Store {
    return new Store(
      undefined,
      withUsersFromTickets({ ...emptyState(), ...structuredClone(init) }),
    );
  }

  /** Только для чтения: менять состояние — через update */
  get state(): Readonly<State> {
    return this.s;
  }

  update<T>(fn: (s: State) => T): Promise<T> {
    return this.lock.run(async () => {
      const result = fn(this.s);
      await this.persist();
      return result;
    });
  }

  private async persist(): Promise<void> {
    if (!this.file) return;
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(this.s, null, 1));
    await rename(tmp, this.file);
  }

  ticket(id: number): Ticket | undefined {
    return this.s.tickets.find((t) => t.id === id);
  }

  ticketByOpsMessage(chatId: number, messageId: number): Ticket | undefined {
    return this.s.tickets.find((t) => t.chatId === chatId && t.opsMessages.includes(messageId));
  }

  ticketByUserMessage(userId: number, messageId: number): Ticket | undefined {
    return this.s.tickets.find((t) => t.userId === userId && t.userMessages.includes(messageId));
  }

  ticketsOf(userId: number): Ticket[] {
    return this.s.tickets.filter((t) => t.userId === userId);
  }
}

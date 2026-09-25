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

/** Заявка, которую сотрудник ещё собирает. */
export interface Draft {
  process: string;
  messages: number[];
  promptId?: number;
  startedAt: string;
}

/** Куда падают заявки процесса. */
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
}

const emptyState = (): State => ({ version: 1, seq: 0, tickets: [], drafts: {}, bindings: {} });

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
      return new Store(file, { ...emptyState(), ...(JSON.parse(raw) as Partial<State>) });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      await mkdir(path.dirname(file), { recursive: true });
      return new Store(file, emptyState());
    }
  }

  static memory(init: Partial<State> = {}): Store {
    return new Store(undefined, { ...emptyState(), ...structuredClone(init) });
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

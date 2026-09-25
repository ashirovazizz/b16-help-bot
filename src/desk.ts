import { timingSafeEqual } from 'node:crypto';
import type { Api } from 'grammy';
import type { Message, User } from 'grammy/types';
import { WorkCalendar } from './core/calendar.js';
import { UserError } from './core/errors.js';
import type { Logger } from './core/logger.js';
import { type Clock, systemClock } from './core/time.js';
import { buildDigest } from './digest.js';
import { PROCESSES, processById } from './processes.js';
import {
  cardKeyboard,
  cardText,
  displayName,
  draftKeyboard,
  HELP,
  menuKeyboard,
  STATUS_LABELS,
  thread,
  when,
} from './render.js';
import { type Binding, OPEN_STATUSES, type Status, type Store, type Ticket } from './store.js';

export interface DeskConfig {
  /** Код для /setup; без него тему задают только через .env */
  setupCode?: string;
  /** Кто может писать боту: только участники рабочего чата или все */
  access: 'chat_members' | 'anyone';
  tz: string;
  slaDays: number;
  holidays: string[];
  /** Привязки из .env важнее заданных командой /setup */
  envBindings: Record<string, Binding>;
}

export type EditorAction = 'take' | 'done' | 'reject' | 'reopen';

const ACTIONS: Record<EditorAction, { from: Status[]; to: Status }> = {
  take: { from: ['new'], to: 'in_work' },
  done: { from: ['new', 'in_work'], to: 'done' },
  reject: { from: ['new', 'in_work'], to: 'rejected' },
  reopen: { from: ['done', 'rejected'], to: 'in_work' },
};

const MEMBER_CACHE_MS = 10 * 60 * 1000;

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Стол заявок: сотрудник собирает заявку в личке, бот кладёт её карточкой
 * в тему рабочего чата и пересылает ответы в обе стороны.
 */
export class Desk {
  private readonly members = new Map<number, { ok: boolean; at: number }>();

  constructor(
    private readonly api: Api,
    private readonly store: Store,
    private readonly cfg: DeskConfig,
    private readonly log: Logger,
    private readonly clock: Clock = systemClock,
  ) {}

  private now(): string {
    return this.clock.now().toISOString();
  }

  /* ───── настройка ───── */

  binding(processId: string): Binding | undefined {
    return this.cfg.envBindings[processId] ?? this.store.state.bindings[processId];
  }

  get configured(): boolean {
    return PROCESSES.some((p) => this.binding(p.id));
  }

  isOpsChat(chatId: number): boolean {
    return PROCESSES.some((p) => this.binding(p.id)?.chatId === chatId);
  }

  /** /setup КОД [процесс] — привязать процесс к теме, где отправлена команда. */
  async setup(msg: Message, args: string[]): Promise<string> {
    const [code = '', processId = 'site'] = args;
    if (!this.cfg.setupCode) {
      return 'Настройка командой выключена: на сервере задан OPS_CHAT_ID в .env.';
    }
    if (msg.chat.type === 'private') {
      return 'Отправьте команду в рабочем чате — в той теме, куда должны приходить заявки.';
    }
    if (!safeEqual(code, this.cfg.setupCode)) {
      return 'Код не подошёл. Его показал установщик на сервере (строка SETUP_CODE в файле .env).';
    }
    const p = processById(processId);
    if (!p) return `Нет процесса «${processId}». Есть: ${PROCESSES.map((x) => x.id).join(', ')}.`;
    const b: Binding = {
      chatId: msg.chat.id,
      ...(msg.message_thread_id !== undefined ? { threadId: msg.message_thread_id } : {}),
    };
    await this.store.update((s) => {
      s.bindings[p.id] = b;
    });
    this.members.clear();
    this.log.info('Процесс привязан к теме', { process: p.id, ...b });
    return `Готово: заявки «${p.title}» будут приходить сюда. Проверьте — напишите боту в личку /start.`;
  }

  /* ───── доступ ───── */

  /** Писать боту могут участники рабочего чата. Если Telegram не ответил, пускаем и пишем в журнал. */
  async canUse(userId: number): Promise<boolean> {
    if (this.cfg.access === 'anyone') return true;
    const chats = [...new Set(PROCESSES.map((p) => this.binding(p.id)?.chatId))].filter(
      (c): c is number => c !== undefined,
    );
    if (!chats.length) return false;
    const cached = this.members.get(userId);
    const nowMs = this.clock.now().getTime();
    if (cached && nowMs - cached.at < MEMBER_CACHE_MS) return cached.ok;
    let ok = false;
    for (const chatId of chats) {
      try {
        const m = await this.api.getChatMember(chatId, userId);
        if (
          m.status === 'creator' ||
          m.status === 'administrator' ||
          m.status === 'member' ||
          (m.status === 'restricted' && m.is_member)
        ) {
          ok = true;
          break;
        }
      } catch (error) {
        this.log.warn('Не удалось проверить участника рабочего чата', { userId, error });
        ok = true;
        break;
      }
    }
    this.members.set(userId, { ok, at: nowMs });
    return ok;
  }

  /* ───── сотрудник ───── */

  async menu(chatId: number, greeting?: string): Promise<void> {
    await this.api.sendMessage(
      chatId,
      greeting ? `${greeting}\n\n${HELP}` : 'Выберите, с чем нужна помощь:',
      {
        reply_markup: menuKeyboard((id) => !!this.binding(id)),
      },
    );
  }

  async startDraft(user: User, processId: string): Promise<void> {
    const p = processById(processId);
    if (!p || !this.binding(p.id)) throw new UserError('Этот раздел пока не настроен.');
    const prompt = await this.api.sendMessage(user.id, p.intro, { reply_markup: draftKeyboard });
    const old = this.store.state.drafts[String(user.id)];
    await this.store.update((s) => {
      s.drafts[String(user.id)] = {
        process: p.id,
        messages: [],
        promptId: prompt.message_id,
        startedAt: this.now(),
      };
    });
    if (old?.promptId) await this.api.editMessageReplyMarkup(user.id, old.promptId).catch(() => {});
  }

  hasDraft(userId: number): boolean {
    return !!this.store.state.drafts[String(userId)];
  }

  /** Сотрудник ответил на сообщение бота по конкретной заявке. */
  isTicketReply(msg: Message): boolean {
    const replyTo = msg.reply_to_message;
    return !!replyTo && !!this.store.ticketByUserMessage(msg.chat.id, replyTo.message_id);
  }

  async addToDraft(userId: number, messageId: number): Promise<void> {
    await this.store.update((s) => {
      s.drafts[String(userId)]?.messages.push(messageId);
    });
    await this.react(userId, messageId);
  }

  async cancelDraft(userId: number): Promise<void> {
    const d = this.store.state.drafts[String(userId)];
    await this.store.update((s) => {
      delete s.drafts[String(userId)];
    });
    if (d?.promptId) {
      await this.api.editMessageText(userId, d.promptId, 'Заявка отменена.').catch(() => {});
    }
  }

  /** Отправка черновика: карточка и копии сообщений — в тему, заявителю — номер заявки. */
  async submit(user: User): Promise<Ticket> {
    const d = this.store.state.drafts[String(user.id)];
    if (!d) throw new UserError('Заявка не начата. Выберите раздел в меню: /start');
    if (!d.messages.length)
      throw new UserError('Сначала напишите, что нужно, — хотя бы одно сообщение.');
    const p = processById(d.process);
    const b = p && this.binding(p.id);
    if (!p || !b) throw new UserError('Этот раздел пока не настроен.');

    const id = await this.store.update((s) => ++s.seq);
    const now = this.now();
    const t: Ticket = {
      id,
      process: p.id,
      userId: user.id,
      userName: displayName(user),
      ...(user.username ? { username: user.username } : {}),
      status: 'new',
      createdAt: now,
      updatedAt: now,
      chatId: b.chatId,
      ...(b.threadId !== undefined ? { threadId: b.threadId } : {}),
      cardId: 0,
      opsMessages: [],
      userMessages: [],
    };
    const card = await this.api.sendMessage(b.chatId, cardText(t, p, this.cfg.tz), {
      parse_mode: 'HTML',
      reply_markup: cardKeyboard(t),
      link_preview_options: { is_disabled: true },
      ...thread(b),
    });
    t.cardId = card.message_id;
    t.opsMessages.push(card.message_id);

    const copies = await this.copyAll(user.id, d.messages, b);
    t.opsMessages.push(...copies.ids);
    if (copies.failed) {
      const warn = await this.api.sendMessage(
        b.chatId,
        `⚠️ ${copies.failed} сообщ. из заявки №${id} Telegram не дал переслать — уточните у заявителя.`,
        {
          ...thread(b),
          reply_parameters: { message_id: t.cardId, allow_sending_without_reply: true },
        },
      );
      t.opsMessages.push(warn.message_id);
    }

    const note = await this.api.sendMessage(
      user.id,
      `Заявка №${id} отправлена. Ответ придёт сюда; чтобы ответить, просто напишите в этот чат.`,
    );
    t.userMessages.push(note.message_id);

    await this.store.update((s) => {
      s.tickets.push(t);
      delete s.drafts[String(user.id)];
    });
    if (d.promptId) await this.api.editMessageReplyMarkup(user.id, d.promptId).catch(() => {});
    this.log.info('Новая заявка', { ticket: id, process: p.id });
    return t;
  }

  private async copyAll(from: number, ids: number[], b: Binding) {
    try {
      const res = await this.api.copyMessages(b.chatId, from, ids, thread(b));
      return { ids: res.map((r) => r.message_id), failed: ids.length - res.length };
    } catch (error) {
      // по одному: пропускаем то, что Telegram копировать не даёт
      this.log.warn('copyMessages не сработал, копирую по одному', { error });
      const out: number[] = [];
      let failed = 0;
      for (const id of ids) {
        try {
          out.push((await this.api.copyMessage(b.chatId, from, id, thread(b))).message_id);
        } catch {
          failed += 1;
        }
      }
      return { ids: out, failed };
    }
  }

  myTickets(userId: number): string {
    const list = this.store
      .ticketsOf(userId)
      .sort((a, b) => b.id - a.id)
      .slice(0, 5);
    if (!list.length) return 'Заявок пока нет.';
    return list
      .map((t) => {
        const p = processById(t.process);
        const who = t.assigneeName ? ` · ${t.assigneeName}` : '';
        return `№${t.id} · ${p?.title ?? t.process} · ${STATUS_LABELS[t.status]}${who} · ${when(t.createdAt, this.cfg.tz)}`;
      })
      .join('\n');
  }

  /* ───── редактор ───── */

  /** Кнопка в карточке. Возвращает текст всплывающего ответа. */
  async act(ticketId: number, action: EditorAction, editor: User, chatId: number): Promise<string> {
    const t = this.store.ticket(ticketId);
    if (!t || t.chatId !== chatId) return 'Заявка не найдена.';
    const rule = ACTIONS[action];
    const name = displayName(editor);
    if (action === 'take' && t.status === 'in_work') {
      return t.assigneeId === editor.id
        ? 'Заявка уже ваша.'
        : `Заявку уже ведёт ${t.assigneeName}.`;
    }
    if (!rule.from.includes(t.status)) return `Уже сделано: ${STATUS_LABELS[t.status]}.`;

    const now = this.now();
    await this.store.update(() => {
      t.status = rule.to;
      t.updatedAt = now;
      if (action === 'take' || !t.assigneeName) {
        t.assigneeId = editor.id;
        t.assigneeName = name;
      }
      if (action === 'take') t.takenAt = now;
      if (rule.to === 'done' || rule.to === 'rejected') t.closedAt = now;
      if (action === 'reopen') {
        delete t.closedAt;
        t.takenAt = now;
      }
    });
    await this.refreshCard(t);

    const texts: Record<EditorAction, string> = {
      take: `Заявка №${t.id} в работе, ведёт ${t.assigneeName}.`,
      done: `✅ Заявка №${t.id} выполнена. Если что-то не так, ответьте на это сообщение.`,
      reject: `Заявка №${t.id} отклонена. Если есть вопросы, ответьте на это сообщение — редактор увидит.`,
      reopen: `Заявку №${t.id} вернули в работу.`,
    };
    await this.tellUser(t, texts[action]);
    const answers: Record<EditorAction, string> = {
      take: 'Заявка закреплена за вами.',
      done: 'Готово, заявитель получил уведомление.',
      reject: 'Отклонено, заявитель получил уведомление. Причину напишите ответом на карточку.',
      reopen: 'Заявка снова в работе.',
    };
    return answers[action];
  }

  private async refreshCard(t: Ticket): Promise<void> {
    const p = processById(t.process);
    if (!p) return;
    try {
      await this.api.editMessageText(t.chatId, t.cardId, cardText(t, p, this.cfg.tz), {
        parse_mode: 'HTML',
        reply_markup: cardKeyboard(t),
        link_preview_options: { is_disabled: true },
      });
    } catch (error) {
      if (!String(error).includes('message is not modified')) {
        this.log.warn('Не удалось обновить карточку', { ticket: t.id, error });
      }
    }
  }

  private async tellUser(t: Ticket, text: string): Promise<void> {
    try {
      const m = await this.api.sendMessage(t.userId, text);
      await this.store.update(() => {
        t.userMessages.push(m.message_id);
      });
    } catch (error) {
      this.log.warn('Не удалось написать заявителю', { ticket: t.id, error });
    }
  }

  /* ───── пересылка ответов ───── */

  /** Ответ в рабочем чате на сообщение заявки уходит заявителю. */
  async relayFromOps(msg: Message): Promise<boolean> {
    const replyTo = msg.reply_to_message;
    if (!replyTo || !msg.from) return false;
    const t = this.store.ticketByOpsMessage(msg.chat.id, replyTo.message_id);
    if (!t) return false;
    const header = `💬 ${displayName(msg.from)} · заявка №${t.id}`;
    const ids = await this.deliver(msg, t.userId, header, {});
    await this.store.update(() => {
      t.userMessages.push(...ids);
      t.updatedAt = this.now();
    });
    await this.react(msg.chat.id, msg.message_id);
    return true;
  }

  /**
   * Сообщение заявителя в личке уходит в ветку его заявки: той, на чьё
   * сообщение он ответил, иначе — последней открытой.
   */
  async relayFromUser(msg: Message): Promise<Ticket | undefined> {
    const userId = msg.chat.id;
    let t = msg.reply_to_message
      ? this.store.ticketByUserMessage(userId, msg.reply_to_message.message_id)
      : undefined;
    if (!t) {
      t = this.store
        .ticketsOf(userId)
        .filter((x) => OPEN_STATUSES.has(x.status))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id - a.id)[0];
    }
    if (!t) return undefined;
    const closed = OPEN_STATUSES.has(t.status) ? '' : ' (закрыта)';
    const header = `💬 ${t.userName} · заявка №${t.id}${closed}`;
    const ids = await this.deliver(msg, t.chatId, header, {
      ...(t.threadId !== undefined ? { message_thread_id: t.threadId } : {}),
      reply_parameters: { message_id: t.cardId, allow_sending_without_reply: true },
    });
    await this.store.update(() => {
      t.opsMessages.push(...ids);
      t.updatedAt = this.now();
    });
    await this.react(userId, msg.message_id);
    return t;
  }

  /** Текст — одним сообщением с подписью, медиа — копией с подписью. */
  private async deliver(
    msg: Message,
    to: number,
    header: string,
    extra: Record<string, unknown>,
  ): Promise<number[]> {
    const opts = { ...extra, link_preview_options: { is_disabled: true } };
    if (msg.text !== undefined && header.length + msg.text.length < 4000) {
      return [(await this.api.sendMessage(to, `${header}\n${msg.text}`, opts)).message_id];
    }
    if (msg.photo || msg.document || msg.video || msg.audio || msg.animation || msg.voice) {
      const caption = [header, msg.caption].filter(Boolean).join('\n').slice(0, 1024);
      return [
        (await this.api.copyMessage(to, msg.chat.id, msg.message_id, { ...extra, caption }))
          .message_id,
      ];
    }
    const head = await this.api.sendMessage(to, header, opts);
    const copy = await this.api.copyMessage(to, msg.chat.id, msg.message_id, extra);
    return [head.message_id, copy.message_id];
  }

  private async react(chatId: number, messageId: number): Promise<void> {
    await this.api
      .setMessageReaction(chatId, messageId, [{ type: 'emoji', emoji: '👌' }])
      .catch(() => {});
  }

  /* ───── сводка ───── */

  async sendDigests(): Promise<number> {
    const now = this.clock.now();
    const calendar = new WorkCalendar(this.cfg.tz, this.cfg.holidays);
    if (!calendar.isWorkingDay(now)) return 0;
    let sent = 0;
    for (const p of PROCESSES) {
      const b = this.binding(p.id);
      if (!b) continue;
      const text = buildDigest({
        tickets: this.store.state.tickets.filter((t) => t.process === p.id),
        process: p,
        now,
        calendar,
        slaDays: this.cfg.slaDays,
      });
      if (!text) continue;
      await this.api.sendMessage(b.chatId, text, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...thread(b),
      });
      sent += 1;
    }
    return sent;
  }
}

import { timingSafeEqual } from 'node:crypto';
import type { Api } from 'grammy';
import type { Message, User } from 'grammy/types';
import { WorkCalendar } from './core/calendar.js';
import { UserError } from './core/errors.js';
import type { Logger } from './core/logger.js';
import { type Clock, systemClock } from './core/time.js';
import { buildDigest } from './digest.js';
import { GROUPS, PROCESSES, type ProcessDef, processById } from './processes.js';
import {
  answersText,
  cardKeyboard,
  cardText,
  displayName,
  draftKeyboard,
  draftStatusText,
  HELP,
  menuKeyboard,
  questionKeyboard,
  STATUS_LABELS,
  summaryKeyboard,
  summaryText,
  thread,
  when,
} from './render.js';
import {
  type Binding,
  type Draft,
  OPEN_STATUSES,
  type Status,
  type Store,
  type Ticket,
} from './store.js';

export interface DeskConfig {
  /** Код для /setup; без него тему задают только через .env */
  setupCode?: string;
  tz: string;
  slaDays: number;
  holidays: string[];
  /** Привязки групп из .env важнее заданных командой /setup */
  envBindings: Record<string, Binding>;
}

export type EditorAction = 'take' | 'done' | 'reject' | 'reopen';

const ACTIONS: Record<EditorAction, { from: Status[]; to: Status }> = {
  take: { from: ['new'], to: 'in_work' },
  done: { from: ['new', 'in_work'], to: 'done' },
  reject: { from: ['new', 'in_work'], to: 'rejected' },
  reopen: { from: ['done', 'rejected'], to: 'in_work' },
};

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const isImage = (msg: Message) => !!msg.photo || !!msg.document?.mime_type?.startsWith('image/');

/**
 * Стол заявок: сотрудник собирает заявку в личке (свободным текстом или
 * по анкете), бот кладёт её карточкой в тему рабочего чата и пересылает
 * ответы в обе стороны.
 */
export class Desk {
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

  binding(group: string): Binding | undefined {
    return this.cfg.envBindings[group] ?? this.store.state.bindings[group];
  }

  bindingOf(p: ProcessDef): Binding | undefined {
    return this.binding(p.group);
  }

  get configured(): boolean {
    return Object.keys(GROUPS).some((g) => this.binding(g));
  }

  isOpsChat(chatId: number): boolean {
    return Object.keys(GROUPS).some((g) => this.binding(g)?.chatId === chatId);
  }

  /** /setup КОД [группа] — заявки группы будут приходить в тему, где отправлена команда. */
  async setup(msg: Message, args: string[]): Promise<string> {
    const [code = '', group = 'site'] = args;
    if (!this.cfg.setupCode) {
      return 'Настройка командой выключена: на сервере задан OPS_CHAT_ID в .env.';
    }
    if (msg.chat.type === 'private') {
      return 'Отправьте команду в рабочем чате — в той теме, куда должны приходить заявки.';
    }
    if (!safeEqual(code, this.cfg.setupCode)) {
      return 'Код не подошёл. Его показал установщик на сервере (строка SETUP_CODE в файле .env).';
    }
    const title = GROUPS[group];
    if (!title) return `Нет раздела «${group}». Есть: ${Object.keys(GROUPS).join(', ')}.`;
    const b: Binding = {
      chatId: msg.chat.id,
      ...(msg.message_thread_id !== undefined ? { threadId: msg.message_thread_id } : {}),
    };
    await this.store.update((s) => {
      s.bindings[group] = b;
    });
    this.log.info('Раздел привязан к теме', { group, ...b });
    return `Готово: заявки раздела «${title}» будут приходить сюда. Проверьте — напишите боту в личку /start.`;
  }

  /* ───── сотрудник: черновик ───── */

  async menu(chatId: number, greeting?: string): Promise<void> {
    await this.api.sendMessage(
      chatId,
      greeting ? `${greeting}\n\n${HELP}` : 'Выберите, что нужно сделать:',
      { reply_markup: menuKeyboard((p) => !!this.bindingOf(p)) },
    );
  }

  private draftOf(userId: number): Draft | undefined {
    return this.store.state.drafts[String(userId)];
  }

  hasDraft(userId: number): boolean {
    return !!this.draftOf(userId);
  }

  /** Сотрудник ответил на сообщение бота по конкретной заявке. */
  isTicketReply(msg: Message): boolean {
    const replyTo = msg.reply_to_message;
    return !!replyTo && !!this.store.ticketByUserMessage(msg.chat.id, replyTo.message_id);
  }

  /** Убирает кнопки у прошлой подсказки и запоминает новую. */
  private async setPrompt(userId: number, promptId: number): Promise<void> {
    const old = this.draftOf(userId)?.promptId;
    await this.store.update((s) => {
      const d = s.drafts[String(userId)];
      if (d) d.promptId = promptId;
    });
    if (old && old !== promptId) {
      await this.api.editMessageReplyMarkup(userId, old).catch(() => {});
    }
  }

  async startDraft(user: User, processId: string): Promise<void> {
    const p = processById(processId);
    if (!p || !this.bindingOf(p)) throw new UserError('Этот раздел пока не настроен.');
    const old = this.draftOf(user.id);
    if (old?.promptId) await this.api.editMessageReplyMarkup(user.id, old.promptId).catch(() => {});
    const guided = !!p.questions?.length;
    const intro = await this.api.sendMessage(
      user.id,
      p.intro,
      guided ? {} : { reply_markup: draftKeyboard },
    );
    await this.store.update((s) => {
      s.drafts[String(user.id)] = {
        process: p.id,
        messages: [],
        promptId: intro.message_id,
        startedAt: this.now(),
        ...(guided ? { step: 0, answers: {} } : {}),
      };
    });
    if (guided) await this.ask(user.id, p, 0);
  }

  /** Следующий вопрос анкеты или итог, если вопросы кончились. */
  private async ask(userId: number, p: ProcessDef, step: number): Promise<void> {
    const questions = p.questions ?? [];
    const q = questions[step];
    if (!q) {
      const answers = this.draftOf(userId)?.answers ?? {};
      const summary = await this.api.sendMessage(userId, summaryText(p, answers), {
        reply_markup: summaryKeyboard,
      });
      await this.setPrompt(userId, summary.message_id);
      return;
    }
    const hint = q.optional ? ' (можно пропустить)' : '';
    const m = await this.api.sendMessage(
      userId,
      `${step + 1}/${questions.length}. ${q.ask}${hint}`,
      {
        reply_markup: questionKeyboard(!!q.optional),
      },
    );
    await this.setPrompt(userId, m.message_id);
  }

  /** Сообщение сотрудника в черновик: ответ на вопрос анкеты или часть свободной заявки. */
  async addToDraft(msg: Message): Promise<void> {
    const userId = msg.chat.id;
    const d = this.draftOf(userId);
    if (!d) return;
    const p = processById(d.process);
    if (!p?.questions?.length || d.step === undefined) {
      const count = await this.store.update((s) => {
        const draft = s.drafts[String(userId)];
        if (!draft) return 0;
        draft.messages.push(msg.message_id);
        draft.lastAt = this.now();
        draft.reminded = false;
        return draft.messages.length;
      });
      await this.showDraftStatus(userId, count);
      return;
    }

    const q = p.questions[d.step];
    if (!q) {
      await this.api.sendMessage(
        userId,
        'Анкета уже заполнена: нажмите «Отправить заявку» или «Заполнить заново».',
      );
      return;
    }
    if (q.kind === 'text' && msg.text === undefined) {
      await this.api.sendMessage(userId, 'Здесь нужен текст — напишите ответ сообщением.');
      return;
    }
    if (q.kind === 'photo' && !isImage(msg)) {
      await this.api.sendMessage(userId, 'Пришлите фото — картинкой или файлом.');
      return;
    }
    const next = d.step + 1;
    await this.store.update((s) => {
      const draft = s.drafts[String(userId)];
      if (!draft) return;
      draft.lastAt = this.now();
      draft.reminded = false;
      draft.answers = {
        ...draft.answers,
        [q.key]: {
          messageId: msg.message_id,
          ...(msg.text !== undefined ? { text: msg.text } : {}),
        },
      };
      draft.step = next;
    });
    await this.react(userId, msg.message_id);
    await this.ask(userId, p, next);
  }

  /**
   * Кнопка «Отправить заявку» всегда под последним сообщением сотрудника:
   * иначе её не видно, и люди думают, что заявка уже ушла.
   */
  private async showDraftStatus(userId: number, count: number): Promise<void> {
    const prev = this.draftOf(userId);
    const old = { statusId: prev?.statusId, promptId: prev?.promptId };
    const status = await this.api.sendMessage(userId, draftStatusText(count), {
      reply_markup: draftKeyboard,
    });
    await this.store.update((s) => {
      const draft = s.drafts[String(userId)];
      if (!draft) return;
      draft.promptId = status.message_id;
      draft.statusId = status.message_id;
    });
    const { statusId, promptId } = old;
    if (statusId) {
      await this.api
        .deleteMessage(userId, statusId)
        .catch(() => this.api.editMessageReplyMarkup(userId, statusId).catch(() => {}));
    } else if (promptId) {
      await this.api.editMessageReplyMarkup(userId, promptId).catch(() => {});
    }
  }

  /** Раз напоминает о заявке, которую начали и не отправили. Возвращает число напоминаний. */
  async remindDrafts(afterMinutes = 30): Promise<number> {
    const now = this.clock.now().getTime();
    let sent = 0;
    for (const [key, d] of Object.entries(this.store.state.drafts)) {
      const userId = Number(key);
      const p = processById(d.process);
      if (!p || d.reminded) continue;
      const guided = !!p.questions?.length;
      const ready = guided ? (d.step ?? 0) >= (p.questions?.length ?? 0) : d.messages.length > 0;
      if (!ready) continue;
      const last = new Date(d.lastAt ?? d.startedAt).getTime();
      if (now - last < afterMinutes * 60_000) continue;
      try {
        const m = await this.api.sendMessage(
          userId,
          '⏳ Ваша заявка ещё не отправлена: редактор её не видит. ' +
            'Если всё написали, нажмите «Отправить заявку».',
          { reply_markup: guided ? summaryKeyboard : draftKeyboard },
        );
        await this.setPrompt(userId, m.message_id);
        sent++;
      } catch (error) {
        this.log.warn('Не удалось напомнить о черновике', { userId, error });
      }
      await this.store.update((s) => {
        const draft = s.drafts[key];
        if (draft) draft.reminded = true;
      });
    }
    return sent;
  }

  async skip(userId: number): Promise<void> {
    const d = this.draftOf(userId);
    const p = d && processById(d.process);
    const q = p?.questions?.[d?.step ?? -1];
    if (!d || !p || !q) throw new UserError('Сейчас нечего пропускать.');
    if (!q.optional) throw new UserError('Этот вопрос обязательный.');
    const next = (d.step ?? 0) + 1;
    await this.store.update((s) => {
      const draft = s.drafts[String(userId)];
      if (draft) draft.step = next;
    });
    await this.ask(userId, p, next);
  }

  async restart(userId: number): Promise<void> {
    const d = this.draftOf(userId);
    const p = d && processById(d.process);
    if (!d || !p?.questions?.length)
      throw new UserError('Заявка не начата. Выберите раздел в меню: /start');
    await this.store.update((s) => {
      const draft = s.drafts[String(userId)];
      if (draft) {
        draft.step = 0;
        draft.answers = {};
      }
    });
    await this.ask(userId, p, 0);
  }

  async cancelDraft(userId: number): Promise<void> {
    const d = this.draftOf(userId);
    await this.store.update((s) => {
      delete s.drafts[String(userId)];
    });
    if (d?.promptId) {
      await this.api.editMessageText(userId, d.promptId, 'Заявка отменена.').catch(() => {});
    }
  }

  /* ───── сотрудник: отправка ───── */

  /** Карточка и содержимое заявки — в тему, заявителю — номер заявки. */
  async submit(user: User): Promise<Ticket> {
    const d = this.draftOf(user.id);
    if (!d) throw new UserError('Заявка не начата. Выберите раздел в меню: /start');
    const p = processById(d.process);
    const b = p && this.bindingOf(p);
    if (!p || !b) throw new UserError('Этот раздел пока не настроен.');
    const guided = !!p.questions?.length;
    if (guided && (d.step ?? 0) < (p.questions?.length ?? 0)) {
      throw new UserError('Сначала ответьте на все вопросы анкеты.');
    }
    if (!guided && !d.messages.length) {
      throw new UserError('Сначала напишите, что нужно, — хотя бы одно сообщение.');
    }

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

    if (guided) {
      t.opsMessages.push(...(await this.sendAnswers(user.id, p, d, b, t.cardId)));
    } else {
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

  /** Анкета для редактора: одно сообщение с подписанными полями и фото отдельно. */
  private async sendAnswers(
    from: number,
    p: ProcessDef,
    d: Draft,
    b: Binding,
    cardId: number,
  ): Promise<number[]> {
    const ids: number[] = [];
    const answers = d.answers ?? {};
    const reply = { reply_parameters: { message_id: cardId, allow_sending_without_reply: true } };
    for (const chunk of answersText(p, answers)) {
      const m = await this.api.sendMessage(b.chatId, chunk, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...thread(b),
        ...reply,
      });
      ids.push(m.message_id);
    }
    for (const q of p.questions ?? []) {
      const a = answers[q.key];
      if (q.kind !== 'photo' || !a) continue;
      try {
        const copy = await this.api.copyMessage(b.chatId, from, a.messageId, {
          ...thread(b),
          ...reply,
          caption: `${q.label} для страницы`,
        });
        ids.push(copy.message_id);
      } catch (error) {
        this.log.warn('Не удалось переслать фото из анкеты', { error });
        const warn = await this.api.sendMessage(
          b.chatId,
          '⚠️ Фото из анкеты Telegram не дал переслать — попросите прислать ещё раз.',
          { ...thread(b), ...reply },
        );
        ids.push(warn.message_id);
      }
    }
    return ids;
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
   * сообщение он ответил, иначе — открытой заявке с последней перепиской.
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
    for (const [group, title] of Object.entries(GROUPS)) {
      const b = this.binding(group);
      if (!b) continue;
      const inGroup = new Set(PROCESSES.filter((p) => p.group === group).map((p) => p.id));
      const text = buildDigest({
        tickets: this.store.state.tickets.filter((t) => inGroup.has(t.process)),
        title,
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

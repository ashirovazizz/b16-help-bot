import { type Api, GrammyError, InlineKeyboard } from 'grammy';
import type { Message, User } from 'grammy/types';
import { UserError } from './core/errors.js';
import type { Logger } from './core/logger.js';
import { type Clock, formatShortDate, systemClock } from './core/time.js';
import type { Desk } from './desk.js';
import { displayName } from './render.js';
import type { BotUser, Campaign, CheckAnswer, Store } from './store.js';

export interface MailerConfig {
  tz: string;
  teamPageUrl: string;
  /** Проверка страниц по умолчанию: напоминание и итоги, в днях */
  checkRemindDays: number;
  checkCloseDays: number;
  /** Пауза между сообщениями рассылки, чтобы не упереться в лимиты Telegram */
  sendDelayMs?: number;
}

const DAY = 86_400_000;

const ANSWER_LABELS: Record<CheckAnswer, string> = {
  ok: '✅ Всё актуально',
  edit: '✏️ Нужны изменения',
  new: '🆕 Нет страницы',
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function daysWord(n: number): string {
  const d = n % 10;
  const dd = n % 100;
  if (d === 1 && dd !== 11) return 'день';
  if (d >= 2 && d <= 4 && (dd < 12 || dd > 14)) return 'дня';
  return 'дней';
}

/**
 * Рассылки из рабочего чата: обычное сообщение всем пользователям бота
 * и проверка страниц с кнопками, напоминанием и итогами.
 * Писать первым Telegram разрешает только тем, кто сам открывал бота.
 */
export class Mailer {
  private sending: Promise<void> = Promise.resolve();

  constructor(
    private readonly api: Api,
    private readonly store: Store,
    private readonly desk: Desk,
    private readonly cfg: MailerConfig,
    private readonly log: Logger,
    private readonly clock: Clock = systemClock,
  ) {}

  private now(): string {
    return this.clock.now().toISOString();
  }

  /* ───── пользователи ───── */

  /** Запоминает каждого, кто пишет боту в личку. */
  async touch(u: User): Promise<void> {
    const key = String(u.id);
    const old = this.store.state.users[key];
    const name = displayName(u);
    const fresh =
      old &&
      !old.blocked &&
      old.name === name &&
      old.username === u.username &&
      this.clock.now().getTime() - new Date(old.lastAt).getTime() < 3_600_000;
    if (fresh) return;
    const now = this.now();
    await this.store.update((s) => {
      s.users[key] = {
        id: u.id,
        name,
        ...(u.username ? { username: u.username } : {}),
        firstAt: old?.firstAt ?? now,
        lastAt: now,
      };
    });
  }

  /** Пользователь заблокировал бота или снова открыл его. */
  async setBlocked(u: User, blocked: boolean): Promise<void> {
    if (!blocked) return this.touch(u);
    await this.store.update((s) => {
      const user = s.users[String(u.id)];
      if (user) user.blocked = true;
    });
  }

  private recipients(): BotUser[] {
    return Object.values(this.store.state.users).filter((u) => !u.blocked);
  }

  private who(id: number): string {
    const u = this.store.state.users[String(id)];
    if (!u) return `id${id}`;
    return u.username ? `${u.name} (@${u.username})` : u.name;
  }

  private campaign(id: number): Campaign | undefined {
    return this.store.state.campaigns.find((c) => c.id === id);
  }

  /* ───── запуск из рабочего чата ───── */

  private requireOps(msg: Message): void {
    if (msg.chat.type === 'private' || !this.desk.isOpsChat(msg.chat.id)) {
      throw new UserError('Рассылку можно запустить только из рабочего чата, где работает бот.');
    }
  }

  private async createPreview(
    msg: Message,
    from: User,
    fields: Pick<Campaign, 'kind'> & Partial<Campaign>,
    describe: (count: number) => string,
  ): Promise<void> {
    const count = this.recipients().length;
    if (!count) throw new UserError('Пока никто не открывал бота — рассылать некому.');
    const id = await this.store.update((s) => ++s.campaignSeq);
    const thread = msg.message_thread_id;
    const c: Campaign = {
      id,
      chatId: msg.chat.id,
      ...(thread !== undefined ? { threadId: thread } : {}),
      authorId: from.id,
      authorName: displayName(from),
      createdAt: this.now(),
      status: 'preview',
      ...fields,
    };
    const preview = await this.api.sendMessage(msg.chat.id, describe(count), {
      ...(thread !== undefined ? { message_thread_id: thread } : {}),
      reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true },
      link_preview_options: { is_disabled: true },
      reply_markup: new InlineKeyboard()
        .text(`📣 Отправить (${count})`, `o:send:${id}`)
        .text('✖️ Отменить', `o:cancel:${id}`),
    });
    c.previewId = preview.message_id;
    await this.store.update((s) => {
      s.campaigns.push(c);
    });
  }

  /** /broadcast текст — или ответом на сообщение, которое надо разослать. */
  async startBroadcast(msg: Message, from: User, text: string, botName: string): Promise<void> {
    this.requireOps(msg);
    const r = msg.reply_to_message;
    // в темах форума «ответ» на первое сообщение темы ставится сам, это не выбор пользователя
    const quoted = r && !r.forum_topic_created && r.message_id !== msg.message_thread_id ? r : null;
    const body = text.trim();
    if (!body && !quoted) {
      throw new UserError(
        `Напишите текст после команды: /broadcast@${botName} Текст рассылки\n` +
          `или ответьте этой командой на сообщение, которое нужно разослать (можно с фото).`,
      );
    }
    const fields: Partial<Campaign> & Pick<Campaign, 'kind'> = body
      ? { kind: 'broadcast', text: body }
      : { kind: 'broadcast', source: { chatId: msg.chat.id, messageId: quoted!.message_id } };
    await this.createPreview(msg, from, fields, (n) =>
      body
        ? `📣 Рассылка получат ${n} чел. — все, кто открывал бота.\n\nТекст:\n${body}`
        : `📣 Рассылка получат ${n} чел. — все, кто открывал бота.\n\nРазошлю сообщение, на которое вы ответили.`,
    );
  }

  /** /pagecheck [дни до напоминания] [дни до итогов] */
  async startCheck(msg: Message, from: User, args: string[]): Promise<void> {
    this.requireOps(msg);
    const nums = args.map(Number);
    if (nums.some((n) => !Number.isInteger(n) || n < 0)) {
      throw new UserError(
        'Формат: /pagecheck [через сколько дней напомнить] [через сколько дней итоги], например /pagecheck 3 7. ' +
          '0 вместо первого числа — без напоминания.',
      );
    }
    const remindDays = nums[0] ?? this.cfg.checkRemindDays;
    const closeDays = nums[1] ?? Math.max(this.cfg.checkCloseDays, remindDays + 1);
    if (closeDays < 1 || closeDays <= remindDays) {
      throw new UserError('Итоги должны прийти позже напоминания: второе число больше первого.');
    }
    const reminder = remindDays
      ? `Не ответившим напомню через ${remindDays} ${daysWord(remindDays)}`
      : 'Напоминания не будет';
    await this.createPreview(msg, from, { kind: 'check', remindDays, closeDays }, (n) =>
      [
        `🔎 Проверка страниц: вопрос получат ${n} чел. — все, кто открывал бота.`,
        `${reminder}, итоги пришлю сюда через ${closeDays} ${daysWord(closeDays)}.`,
        '',
        'Сообщение:',
        this.checkText(),
      ].join('\n'),
    );
  }

  private checkText(reminder = false): string {
    return [
      reminder
        ? 'Напоминаем: проверьте, пожалуйста, свою страницу на сайте центра.'
        : 'Здравствуйте! Мы проверяем страницы команды на сайте центра.',
      `Найдите себя здесь: ${this.cfg.teamPageUrl}`,
      '',
      'Всё на вашей странице актуально?',
    ].join('\n');
  }

  private checkKeyboard(id: number): InlineKeyboard {
    return new InlineKeyboard()
      .text('✅ Всё актуально', `c:ok:${id}`)
      .row()
      .text('✏️ Нужно изменить', `c:edit:${id}`)
      .text('🆕 Страницы нет', `c:new:${id}`);
  }

  /** Кнопки под предпросмотром. Подтвердить или отменить может только автор. */
  async confirm(id: number, action: 'send' | 'cancel', from: User): Promise<string> {
    const c = this.campaign(id);
    if (!c) return 'Рассылка не найдена';
    if (c.authorId !== from.id) return `Подтвердить может только ${c.authorName}`;
    if (c.status !== 'preview') return 'Уже решено';
    if (action === 'cancel') {
      await this.store.update((s) => {
        const x = s.campaigns.find((y) => y.id === id);
        if (x) x.status = 'cancelled';
      });
      if (c.previewId) {
        await this.api.editMessageText(c.chatId, c.previewId, 'Рассылка отменена.').catch(() => {});
      }
      return 'Отменено';
    }
    await this.store.update((s) => {
      const x = s.campaigns.find((y) => y.id === id);
      if (x) x.status = 'sending';
    });
    // рассылка может идти долго — не держим кнопку
    this.sending = this.sending
      .then(() => this.send(id))
      .catch((error) => this.log.error('Рассылка сорвалась', { id, error }));
    return 'Отправляю';
  }

  /** Дождаться рассылок, которые уже идут. */
  idle(): Promise<void> {
    return this.sending;
  }

  /** Рассылает и отчитывается в рабочем чате. Возвращается, когда всё отправлено. */
  async send(id: number): Promise<void> {
    const c = this.campaign(id);
    if (!c) return;
    if (c.previewId) {
      await this.api.editMessageReplyMarkup(c.chatId, c.previewId).catch(() => {});
    }
    const delivered: number[] = [];
    const failed: number[] = [];
    for (const u of this.recipients()) {
      try {
        if (c.kind === 'check') {
          await this.api.sendMessage(u.id, this.checkText(), {
            reply_markup: this.checkKeyboard(id),
            link_preview_options: { is_disabled: true },
          });
        } else if (c.source) {
          await this.api.copyMessage(u.id, c.source.chatId, c.source.messageId);
        } else {
          await this.api.sendMessage(u.id, c.text ?? '');
        }
        delivered.push(u.id);
      } catch (error) {
        failed.push(u.id);
        if (error instanceof GrammyError && error.error_code === 403) {
          await this.store.update((s) => {
            const x = s.users[String(u.id)];
            if (x) x.blocked = true;
          });
        } else {
          this.log.warn('Не доставлено', { campaign: id, user: u.id, error });
        }
      }
      if (this.cfg.sendDelayMs) await sleep(this.cfg.sendDelayMs);
    }
    await this.store.update((s) => {
      const x = s.campaigns.find((y) => y.id === id);
      if (!x) return;
      x.status = 'sent';
      x.sentAt = this.now();
      x.delivered = delivered;
      x.failed = failed;
      x.answers = {};
    });
    const lines = [
      `${c.kind === 'check' ? '🔎 Проверка страниц' : '📣 Рассылка'} отправлена: ${delivered.length} из ${delivered.length + failed.length}.`,
    ];
    if (failed.length) {
      lines.push(
        `Не доставлено (заблокировали бота): ${failed.map((u) => this.who(u)).join(', ')}`,
      );
    }
    if (c.kind === 'check') lines.push('Итоги в любой момент: /checkstatus');
    await this.report(c, lines.join('\n'));
  }

  private async report(c: Campaign, text: string): Promise<void> {
    await this.api
      .sendMessage(c.chatId, text.slice(0, 4000), {
        ...(c.threadId !== undefined ? { message_thread_id: c.threadId } : {}),
        ...(c.previewId
          ? { reply_parameters: { message_id: c.previewId, allow_sending_without_reply: true } }
          : {}),
      })
      .catch((error) => this.log.warn('Не удалось отправить отчёт о рассылке', { error }));
  }

  /* ───── ответы на проверку ───── */

  async answer(id: number, answer: CheckAnswer, from: User, messageId?: number): Promise<string> {
    const c = this.campaign(id);
    if (!c || c.kind !== 'check') return 'Проверка уже не идёт';
    await this.store.update((s) => {
      const x = s.campaigns.find((y) => y.id === id);
      if (x) x.answers = { ...x.answers, [String(from.id)]: { answer, at: this.now() } };
    });
    const tail = {
      ok: 'Спасибо! Отметили, что всё актуально.',
      edit: 'Опишите ниже, что поменять.',
      new: 'Заполним анкету для новой страницы.',
    }[answer];
    if (messageId) {
      await this.api
        .editMessageText(from.id, messageId, `${this.checkText()}\n\n${tail}`, {
          link_preview_options: { is_disabled: true },
        })
        .catch(() => {});
    }
    if (answer !== 'ok') await this.desk.startDraft(from, answer === 'edit' ? 'site' : 'site_new');
    return answer === 'ok' ? 'Спасибо!' : '';
  }

  /* ───── итоги, напоминания ───── */

  summary(c: Campaign): string {
    const delivered = c.delivered ?? [];
    const answers = c.answers ?? {};
    const by = (a: CheckAnswer) => delivered.filter((u) => answers[String(u)]?.answer === a);
    const silent = delivered.filter((u) => !answers[String(u)]);
    const list = (ids: number[]) => ids.map((u) => this.who(u)).join(', ');
    const answered = delivered.length - silent.length;
    const lines = [
      `🔎 Проверка страниц от ${formatShortDate(new Date(c.sentAt ?? c.createdAt), this.cfg.tz)}: ответили ${answered} из ${delivered.length}.`,
    ];
    for (const a of ['ok', 'edit', 'new'] as const) {
      const ids = by(a);
      if (ids.length) lines.push(`${ANSWER_LABELS[a]} (${ids.length}): ${list(ids)}`);
    }
    if (silent.length) lines.push(`Не ответили (${silent.length}): ${list(silent)}`);
    if (c.failed?.length) lines.push(`Не доставлено (${c.failed.length}): ${list(c.failed)}`);
    return lines.join('\n');
  }

  /** /checkstatus — итоги последней проверки. */
  status(msg: Message): string {
    this.requireOps(msg);
    const c = [...this.store.state.campaigns]
      .reverse()
      .find((x) => x.kind === 'check' && (x.status === 'sent' || x.status === 'closed'));
    return c ? this.summary(c) : 'Проверок страниц ещё не было. Запустить: /pagecheck';
  }

  /** Раз в несколько минут: напоминания и итоги проверок. */
  async tick(): Promise<void> {
    const now = this.clock.now().getTime();
    for (const c of this.store.state.campaigns) {
      if (c.kind !== 'check' || c.status !== 'sent' || !c.sentAt) continue;
      const sent = new Date(c.sentAt).getTime();
      if (c.remindDays && !c.remindedAt && now >= sent + c.remindDays * DAY) {
        await this.remind(c);
      }
      if (now >= sent + (c.closeDays ?? 7) * DAY) {
        await this.store.update((s) => {
          const x = s.campaigns.find((y) => y.id === c.id);
          if (!x) return;
          x.status = 'closed';
          x.closedAt = this.now();
        });
        await this.report(c, `Итоги:\n${this.summary(c)}`);
      }
    }
  }

  private async remind(c: Campaign): Promise<void> {
    await this.store.update((s) => {
      const x = s.campaigns.find((y) => y.id === c.id);
      if (x) x.remindedAt = this.now();
    });
    const silent = (c.delivered ?? []).filter((u) => !c.answers?.[String(u)]);
    let sent = 0;
    for (const u of silent) {
      try {
        await this.api.sendMessage(u, this.checkText(true), {
          reply_markup: this.checkKeyboard(c.id),
          link_preview_options: { is_disabled: true },
        });
        sent++;
      } catch (error) {
        this.log.warn('Не удалось напомнить о проверке', { campaign: c.id, user: u, error });
      }
      if (this.cfg.sendDelayMs) await sleep(this.cfg.sendDelayMs);
    }
    await this.report(c, `Напомнил ${sent} чел., кто ещё не ответил.\n\n${this.summary(c)}`);
  }
}

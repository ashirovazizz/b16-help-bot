import { Menu } from '@grammyjs/menu';
import { type Api, type Context, GrammyError, InlineKeyboard } from 'grammy';
import type { Message, User } from 'grammy/types';
import { UserError } from './core/errors.js';
import type { Logger } from './core/logger.js';
import { type Clock, formatShortDate, systemClock } from './core/time.js';
import { type Desk, MAIL_TOPIC } from './desk.js';
import { displayName } from './render.js';
import type { Binding, BotUser, Campaign, CheckAnswer, Store } from './store.js';

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
/** Неподтверждённый предпросмотр живёт час, потом бот его убирает */
const PREVIEW_TTL = 3_600_000;
/** Варианты сроков проверки: кнопка переключает по кругу */
const REMIND_STEPS = [0, 1, 2, 3, 5, 7];
const CLOSE_STEPS = [3, 5, 7, 10, 14];

const ANSWER_LABELS: Record<CheckAnswer, string> = {
  ok: '✅ Всё актуально',
  edit: '✏️ Нужны изменения',
  new: '🆕 Нет страницы',
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function days(n: number): string {
  const d = n % 10;
  const dd = n % 100;
  if (d === 1 && dd !== 11) return `${n} день`;
  if (d >= 2 && d <= 4 && (dd < 12 || dd > 14)) return `${n} дня`;
  return `${n} дней`;
}

const nextOf = (steps: number[], current: number) => steps.find((x) => x > current) ?? steps[0]!;

/**
 * Рассылки ведутся в отдельной теме рабочего чата («Рассылки»), бот там
 * администратор и видит все сообщения. Любое сообщение в теме — заготовка
 * рассылки: бот отвечает предпросмотром с кнопками, а после отправки
 * превращает его в отчёт. Вверху темы — панель (плагин @grammyjs/menu):
 * проверка страниц, получатели, итоги; переходы правят её на месте.
 * Писать первым Telegram разрешает только тем, кто сам открывал бота.
 */
export class Mailer {
  private sending: Promise<void> = Promise.resolve();
  /** Панель темы «Рассылки»; подключается в боте через bot.use(mailer.menu) */
  readonly menu: Menu<Context>;

  constructor(
    private readonly api: Api,
    private readonly store: Store,
    private readonly desk: Desk,
    private readonly cfg: MailerConfig,
    private readonly log: Logger,
    private readonly clock: Clock = systemClock,
  ) {
    this.menu = this.buildMenu();
  }

  private buildMenu(): Menu<Context> {
    const edit = (ctx: Context, text: string) =>
      ctx
        .editMessageText(text.slice(0, 4000), { link_preview_options: { is_disabled: true } })
        .catch(() => {}); // «message is not modified» — текст не изменился
    const root = new Menu<Context>('mail', { onMenuOutdated: 'Панель обновилась, нажмите ещё раз' })
      .text('🔎 Проверка страниц', async (ctx) => {
        if (!ctx.from) return;
        const hint = await this.newCheck(ctx.from);
        if (hint) await ctx.answerCallbackQuery({ text: hint, show_alert: true });
      })
      .row()
      .submenu('👥 Получатели', 'mail-users', (ctx) => edit(ctx, this.usersText()))
      .submenu('📊 Итоги проверки', 'mail-status', (ctx) => edit(ctx, this.statusText()))
      .row()
      .text('🔄 Обновить', (ctx) => edit(ctx, this.panelText()));
    const users = new Menu<Context>('mail-users')
      .text('🔄 Обновить', (ctx) => edit(ctx, this.usersText()))
      .back('← Назад', (ctx) => edit(ctx, this.panelText()));
    const status = new Menu<Context>('mail-status')
      .text('🔄 Обновить', (ctx) => edit(ctx, this.statusText()))
      .back('← Назад', (ctx) => edit(ctx, this.panelText()));
    root.register([users, status]);
    return root;
  }

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

  private async patch(id: number, fn: (c: Campaign) => void): Promise<void> {
    await this.store.update((s) => {
      const c = s.campaigns.find((x) => x.id === id);
      if (c) fn(c);
    });
  }

  /* ───── тема «Рассылки» ───── */

  private get topic(): Binding | undefined {
    return this.desk.binding(MAIL_TOPIC);
  }

  /** Сообщение из темы «Рассылки» (или кнопка под ним). */
  inMailTopic(chatId: number | undefined, threadId: number | undefined): boolean {
    const b = this.topic;
    return !!b && b.chatId === chatId && (b.threadId === undefined || b.threadId === threadId);
  }

  private where(): { message_thread_id?: number } {
    const t = this.topic?.threadId;
    return t !== undefined ? { message_thread_id: t } : {};
  }

  private panelText(): string {
    const users = Object.values(this.store.state.users);
    const active = users.filter((u) => !u.blocked).length;
    return [
      '📣 Рассылки',
      `Получателей: ${active} — все, кто открывал бота.`,
      '',
      'Чтобы разослать сообщение, просто напишите его в эту тему: текст, фото, файл, альбом. ' +
        'Бот покажет, сколько человек его получат, и отправит после кнопки «Отправить».',
    ].join('\n');
  }

  /**
   * Панель в теме «Рассылки». Старая панель удаляется, чтобы она была одна.
   * Меню рисуется только запросами из обработчика, поэтому нужен ctx.api.
   */
  async showPanel(api: Api): Promise<void> {
    const b = this.topic;
    if (!b) return;
    const old = this.store.state.mailPanel;
    const m = await api.sendMessage(b.chatId, this.panelText(), {
      ...this.where(),
      reply_markup: this.menu,
    });
    await this.store.update((s) => {
      s.mailPanel = { chatId: b.chatId, messageId: m.message_id };
    });
    if (old) await this.api.deleteMessage(old.chatId, old.messageId).catch(() => {});
  }

  private usersText(): string {
    const all = Object.values(this.store.state.users).sort((a, b) =>
      a.name.localeCompare(b.name, 'ru'),
    );
    if (!all.length) return '👥 Пока никто не открывал бота.';
    const active = all.filter((u) => !u.blocked);
    const blocked = all.filter((u) => u.blocked);
    const line = (u: BotUser) =>
      `${u.name}${u.username ? ` (@${u.username})` : ''} — с ${formatShortDate(new Date(u.firstAt), this.cfg.tz)}`;
    const lines = [
      `👥 Получатели: ${active.length}`,
      ...active.map((u, i) => `${i + 1}. ${line(u)}`),
    ];
    if (blocked.length) {
      lines.push('', `Заблокировали бота (${blocked.length}):`, ...blocked.map(line));
    }
    return lines.join('\n');
  }

  private statusText(): string {
    const c = [...this.store.state.campaigns]
      .reverse()
      .find((x) => x.kind === 'check' && (x.status === 'sent' || x.status === 'closed'));
    return c ? this.summary(c) : '📊 Проверок страниц ещё не было.';
  }

  /* ───── обычная рассылка ───── */

  /**
   * Сообщение в теме «Рассылки» — заготовка рассылки. Команды, служебные
   * сообщения, сообщения ботов и ответы на сообщения бота не трогаем.
   * Альбом приходит несколькими сообщениями — собираем его в одну рассылку.
   */
  async takeContent(msg: Message): Promise<boolean> {
    if (!this.inMailTopic(msg.chat.id, msg.message_thread_id) || !msg.from || msg.from.is_bot) {
      return false;
    }
    const isCommand = msg.entities?.[0]?.type === 'bot_command' && msg.entities[0].offset === 0;
    const content = [
      msg.text,
      msg.caption,
      msg.photo,
      msg.video,
      msg.document,
      msg.audio,
      msg.voice,
      msg.animation,
      msg.video_note,
      msg.sticker,
      msg.poll,
    ].some((x) => x !== undefined && x !== '');
    const r = msg.reply_to_message;
    const repliesToBot = !!r && !r.forum_topic_created && r.from?.is_bot === true;
    if (isCommand || !content || repliesToBot) return true;

    if (msg.media_group_id) {
      const album = this.store.state.campaigns.find(
        (c) => c.status === 'preview' && c.source?.mediaGroupId === msg.media_group_id,
      );
      if (album) {
        await this.patch(album.id, (x) => {
          x.source?.messageIds?.push(msg.message_id);
        });
        return true;
      }
    }

    const count = this.recipients().length;
    const id = await this.store.update((s) => ++s.campaignSeq);
    const b = this.topic!;
    await this.store.update((s) => {
      s.campaigns.push({
        id,
        kind: 'broadcast',
        chatId: msg.chat.id,
        ...(b.threadId !== undefined ? { threadId: b.threadId } : {}),
        authorId: msg.from!.id,
        authorName: displayName(msg.from!),
        createdAt: this.now(),
        status: 'preview',
        source: {
          chatId: msg.chat.id,
          messageId: msg.message_id,
          messageIds: [msg.message_id],
          ...(msg.media_group_id ? { mediaGroupId: msg.media_group_id } : {}),
        },
      });
    });
    const text = count
      ? `Разослать это сообщение? Получат ${count} чел.`
      : 'Разослать некому: бота ещё никто не открывал.';
    const preview = await this.api.sendMessage(msg.chat.id, text, {
      ...this.where(),
      reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true },
      ...(count
        ? { reply_markup: this.confirmKeyboard(id, count) }
        : { reply_markup: new InlineKeyboard().text('✖️ Убрать', `o:cancel:${id}`) }),
    });
    await this.patch(id, (x) => {
      x.previewId = preview.message_id;
    });
    return true;
  }

  private confirmKeyboard(id: number, count: number): InlineKeyboard {
    return new InlineKeyboard()
      .text(`📣 Отправить (${count})`, `o:send:${id}`)
      .text('✖️ Отменить', `o:cancel:${id}`);
  }

  /* ───── проверка страниц ───── */

  private async newCheck(from: User): Promise<string> {
    const b = this.topic;
    if (!b) return '';
    if (!this.recipients().length) return 'Пока никто не открывал бота — спрашивать некого.';
    const id = await this.store.update((s) => ++s.campaignSeq);
    const remindDays = this.cfg.checkRemindDays;
    const closeDays = Math.max(this.cfg.checkCloseDays, remindDays + 1);
    const c: Campaign = {
      id,
      kind: 'check',
      chatId: b.chatId,
      ...(b.threadId !== undefined ? { threadId: b.threadId } : {}),
      authorId: from.id,
      authorName: displayName(from),
      createdAt: this.now(),
      status: 'preview',
      remindDays,
      closeDays,
    };
    const m = await this.api.sendMessage(b.chatId, this.checkPreviewText(c), {
      ...this.where(),
      link_preview_options: { is_disabled: true },
      reply_markup: this.checkPreviewKeyboard(c),
    });
    c.previewId = m.message_id;
    await this.store.update((s) => {
      s.campaigns.push(c);
    });
    return '';
  }

  private checkPreviewText(c: Campaign): string {
    const n = this.recipients().length;
    const remind = c.remindDays ? `напомню через ${days(c.remindDays)}` : 'без напоминания';
    return [
      `🔎 Проверка страниц: вопрос получат ${n} чел.`,
      `Не ответившим ${remind}, итоги пришлю сюда через ${days(c.closeDays ?? 7)}.`,
      'Сроки меняются кнопками ниже.',
      '',
      '———',
      this.checkText(),
    ].join('\n');
  }

  private checkPreviewKeyboard(c: Campaign): InlineKeyboard {
    const n = this.recipients().length;
    return new InlineKeyboard()
      .text(
        c.remindDays ? `⏰ Напомнить: через ${days(c.remindDays)}` : '⏰ Без напоминания',
        `o:remind:${c.id}`,
      )
      .row()
      .text(`📊 Итоги: через ${days(c.closeDays ?? 7)}`, `o:close:${c.id}`)
      .row()
      .text(`📣 Отправить (${n})`, `o:send:${c.id}`)
      .text('✖️ Отменить', `o:cancel:${c.id}`);
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

  /* ───── кнопки под предпросмотром ───── */

  /** Отправить, отменить, сроки проверки, обновить итоги. Возвращает подсказку. */
  async confirm(id: number, action: string, from: User): Promise<string> {
    const c = this.campaign(id);
    if (!c) return 'Рассылка не найдена';
    if (action === 'stat') {
      await this.editPreview(c, this.summary(c), this.statusKeyboard(c));
      return 'Обновлено';
    }
    if (c.status !== 'preview') return 'Уже решено';
    if (c.authorId !== from.id) return `Это рассылка ${c.authorName}: решает автор`;
    if (action === 'remind' || action === 'close') {
      await this.patch(id, (x) => {
        if (action === 'remind') x.remindDays = nextOf(REMIND_STEPS, x.remindDays ?? 0);
        else x.closeDays = nextOf(CLOSE_STEPS, x.closeDays ?? 7);
        // итоги всегда позже напоминания
        if ((x.closeDays ?? 7) <= (x.remindDays ?? 0)) {
          x.closeDays = CLOSE_STEPS.find((d) => d > (x.remindDays ?? 0)) ?? 14;
        }
      });
      const fresh = this.campaign(id)!;
      await this.editPreview(fresh, this.checkPreviewText(fresh), this.checkPreviewKeyboard(fresh));
      return '';
    }
    if (action === 'cancel') {
      await this.patch(id, (x) => {
        x.status = 'cancelled';
      });
      if (c.previewId) await this.api.deleteMessage(c.chatId, c.previewId).catch(() => {});
      for (const m of c.source?.messageIds ?? []) {
        await this.api.deleteMessage(c.chatId, m).catch(() => {});
      }
      return 'Отменено';
    }
    await this.patch(id, (x) => {
      x.status = 'sending';
    });
    await this.editPreview(c, '⏳ Отправляю…');
    // рассылка может идти долго — не держим кнопку
    this.sending = this.sending
      .then(() => this.send(id))
      .catch((error) => this.log.error('Рассылка сорвалась', { id, error }));
    return 'Отправляю';
  }

  private async editPreview(c: Campaign, text: string, kb?: InlineKeyboard): Promise<void> {
    if (!c.previewId) return;
    await this.api
      .editMessageText(c.chatId, c.previewId, text.slice(0, 4000), {
        link_preview_options: { is_disabled: true },
        ...(kb ? { reply_markup: kb } : {}),
      })
      .catch(() => {});
  }

  private statusKeyboard(c: Campaign): InlineKeyboard {
    return new InlineKeyboard().text('🔄 Обновить итоги', `o:stat:${c.id}`);
  }

  /** Дождаться рассылок, которые уже идут. */
  idle(): Promise<void> {
    return this.sending;
  }

  /** Рассылает и превращает предпросмотр в отчёт. */
  async send(id: number): Promise<void> {
    const c = this.campaign(id);
    if (!c) return;
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
          const ids = c.source.messageIds ?? [c.source.messageId];
          if (ids.length > 1) {
            await this.api.copyMessages(
              u.id,
              c.source.chatId,
              [...ids].sort((a, b) => a - b),
            );
          } else {
            await this.api.copyMessage(u.id, c.source.chatId, ids[0]!);
          }
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
    await this.patch(id, (x) => {
      x.status = 'sent';
      x.sentAt = this.now();
      x.delivered = delivered;
      x.failed = failed;
      x.answers = {};
    });
    const done = this.campaign(id)!;
    if (c.kind === 'check') {
      await this.editPreview(done, this.summary(done), this.statusKeyboard(done));
    } else {
      const lines = [`✅ Разослано: ${delivered.length} из ${delivered.length + failed.length}.`];
      if (failed.length) {
        lines.push(`Не дошло (заблокировали бота): ${failed.map((u) => this.who(u)).join(', ')}`);
      }
      await this.editPreview(done, lines.join('\n'));
    }
  }

  /* ───── ответы на проверку ───── */

  async answer(id: number, answer: CheckAnswer, from: User, messageId?: number): Promise<string> {
    const c = this.campaign(id);
    if (!c || c.kind !== 'check') return 'Проверка уже не идёт';
    await this.patch(id, (x) => {
      x.answers = { ...x.answers, [String(from.id)]: { answer, at: this.now() } };
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
    if (c.status === 'sent' && c.sentAt) {
      const sent = new Date(c.sentAt).getTime();
      if (c.remindDays && !c.remindedAt) {
        lines.push(
          '',
          `Напомню не ответившим ${formatShortDate(new Date(sent + c.remindDays * DAY), this.cfg.tz)}.`,
        );
      } else if (c.remindedAt) {
        lines.push('', `Напомнил ${formatShortDate(new Date(c.remindedAt), this.cfg.tz)}.`);
      }
      lines.push(
        `Итоги пришлю ${formatShortDate(new Date(sent + (c.closeDays ?? 7) * DAY), this.cfg.tz)}.`,
      );
    }
    if (c.status === 'closed') lines.push('', 'Проверка завершена.');
    return lines.join('\n');
  }

  /** Раз в несколько минут: напоминания, итоги проверок, брошенные черновики. */
  async tick(): Promise<void> {
    const now = this.clock.now().getTime();
    for (const c of this.store.state.campaigns) {
      if (c.status === 'preview' && now - new Date(c.createdAt).getTime() > PREVIEW_TTL) {
        // предпросмотр так и не подтвердили — убираем, сообщение автора остаётся
        await this.patch(c.id, (x) => {
          x.status = 'cancelled';
        });
        if (c.previewId) await this.api.deleteMessage(c.chatId, c.previewId).catch(() => {});
        continue;
      }
      if (c.kind !== 'check' || c.status !== 'sent' || !c.sentAt) continue;
      const sent = new Date(c.sentAt).getTime();
      if (c.remindDays && !c.remindedAt && now >= sent + c.remindDays * DAY) {
        await this.remind(c);
      }
      if (now >= sent + (c.closeDays ?? 7) * DAY) {
        await this.patch(c.id, (x) => {
          x.status = 'closed';
          x.closedAt = this.now();
        });
        const closed = this.campaign(c.id)!;
        await this.editPreview(closed, this.summary(closed));
        // итоги — новым сообщением, чтобы пришло уведомление
        await this.api
          .sendMessage(c.chatId, `📊 Итоги проверки страниц\n\n${this.summary(closed)}`, {
            ...(c.threadId !== undefined ? { message_thread_id: c.threadId } : {}),
            ...(c.previewId
              ? { reply_parameters: { message_id: c.previewId, allow_sending_without_reply: true } }
              : {}),
          })
          .catch((error) => this.log.warn('Не удалось прислать итоги проверки', { error }));
      }
    }
  }

  private async remind(c: Campaign): Promise<void> {
    await this.patch(c.id, (x) => {
      x.remindedAt = this.now();
    });
    const silent = (c.delivered ?? []).filter((u) => !c.answers?.[String(u)]);
    for (const u of silent) {
      await this.api
        .sendMessage(u, this.checkText(true), {
          reply_markup: this.checkKeyboard(c.id),
          link_preview_options: { is_disabled: true },
        })
        .catch((error) =>
          this.log.warn('Не удалось напомнить о проверке', { campaign: c.id, user: u, error }),
        );
      if (this.cfg.sendDelayMs) await sleep(this.cfg.sendDelayMs);
    }
    const fresh = this.campaign(c.id)!;
    await this.editPreview(fresh, this.summary(fresh), this.statusKeyboard(fresh));
  }

  /** Команда /mail: показать панель заново; вне темы рассылок — подсказка. */
  async panelCommand(msg: Message, botName: string, api: Api): Promise<void> {
    if (!this.topic) {
      throw new UserError(
        `Сначала выберите тему для рассылок: создайте в рабочем чате тему «Рассылки» и отправьте в ней /setup@${botName} КОД mail`,
      );
    }
    if (!this.inMailTopic(msg.chat.id, msg.message_thread_id)) {
      throw new UserError('Рассылки — в теме «Рассылки» рабочего чата.');
    }
    await this.api.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});
    await this.showPanel(api);
  }
}

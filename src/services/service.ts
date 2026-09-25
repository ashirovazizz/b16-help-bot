import { WorkCalendar } from '../core/calendar.js';
import { UserError } from '../core/errors.js';
import type { Logger } from '../core/logger.js';
import { Mutex } from '../core/mutex.js';
import { type Clock, DAY_MS, formatDate, formatShortDate } from '../core/time.js';
import type { LinkRole } from '../core/tokens.js';
import { randomCode } from '../core/tokens.js';
import { FIELD_BY_KEY, type FieldKey, PHOTO_LABEL } from '../domain/fields.js';
import {
  type HistoryEvent,
  isOpen,
  type Profile,
  REQUEST_TYPE_LABELS,
  type Request,
  type RequestStatus,
  type RequestType,
  type Settings,
  STATUS_LABELS,
} from '../domain/model.js';
import {
  applyToProfile,
  checkSubmission,
  type FormErrorKey,
  formValues,
  hasErrors,
  normalizeText,
  profileDiff,
} from '../domain/validation.js';
import {
  ACTION_EVENTS,
  type Action,
  type Actor,
  applyTransition,
  checkTransition,
  dueFor,
  hasRequester,
  REGISTRY_ACTOR,
  SYSTEM_ACTOR,
} from '../domain/workflow.js';
import { inspectPhoto, PhotoError } from '../photos/inspect.js';
import {
  formatPersonId,
  type PersonRow,
  parsePersonNumber,
  type Repository,
} from '../storage/repository.js';
import { buildDigest } from './digest.js';
import type { Links } from './links.js';
import {
  autoConfirmedMessage,
  changedLabels,
  fixMessage,
  formInvite,
  needInfoMessage,
  publishedMessage,
  rejectedMessage,
  reminderMessage,
  reviewReminder,
} from './messages.js';
import type {
  Attachment,
  CardView,
  Notifier,
  OutMessage,
  PhotoStore,
  SiteChecker,
  StoredPhoto,
} from './ports.js';

export interface ServiceDeps {
  repo: Repository;
  notifier: Notifier;
  photos: PhotoStore;
  links: Links;
  clock: Clock;
  tz: string;
  log: Logger;
  site?: SiteChecker;
  /** Сколько держать настройки в памяти, мс */
  settingsTtlMs?: number;
}

export interface TelegramUser {
  id: number;
  username?: string;
  name: string;
}

export interface SyncReport {
  assignedIds: string[];
  created: string[];
  archived: string[];
  withdrawn: string[];
  invites: string[];
  problems: string[];
}

export interface BindResult {
  person: PersonRow;
  alreadyBound: boolean;
  /** Анкета новой страницы, которую пора заполнить */
  pending?: { request: Request; message: OutMessage };
}

export type StartUpdateResult =
  | { kind: 'form'; request: Request; message: OutMessage; created: boolean }
  | { kind: 'waiting'; request: Request }
  | { kind: 'review'; request: Request; message: OutMessage };

export type PublishResult =
  | { kind: 'needUrl'; request: Request }
  | { kind: 'done'; request: Request; warning?: string };

export interface FormModel {
  request: Request;
  role: LinkRole;
  editable: boolean;
  notice?: string;
  values: Record<FieldKey, string>;
  current?: Profile;
  hasNewPhoto: boolean;
  hasCurrentPhoto: boolean;
}

export interface FormInput {
  fields: Partial<Record<FieldKey, string>>;
  photo?: Uint8Array;
  comment?: string;
}

export type SubmitResult =
  | { ok: true; request: Request }
  | { ok: false; errors: Partial<Record<FormErrorKey, string>>; model: FormModel };

const REQUESTER_EDITABLE: readonly RequestStatus[] = ['draft', 'needs_info'];

function appendNote(note: string, line: string): string {
  return note ? `${note}\n${line}` : line;
}

/**
 * Сервис заявок: все сценарии процесса. Каждый публичный метод выполняется
 * под общим замком, поэтому внутри можно спокойно читать и переписывать строки.
 */
export class RequestService {
  private readonly lock = new Mutex();
  private settingsCache?: { at: number; value: Settings };
  private lastProblems: string[] = [];

  constructor(private readonly d: ServiceDeps) {}

  /* ───────────────────────── окружение ───────────────────────── */

  private async settings(): Promise<Settings> {
    const ttl = this.d.settingsTtlMs ?? 5 * 60 * 1000;
    const nowMs = this.d.clock.now().getTime();
    if (this.settingsCache && nowMs - this.settingsCache.at < ttl) return this.settingsCache.value;
    const value = await this.d.repo.loadSettings();
    this.settingsCache = { at: nowMs, value };
    return value;
  }

  private async env() {
    const settings = await this.settings();
    const calendar = new WorkCalendar(this.d.tz, settings.holidays, settings.workdays);
    return { settings, calendar, now: this.d.clock.now() };
  }

  async calendar(): Promise<WorkCalendar> {
    return (await this.env()).calendar;
  }

  async digestTime(): Promise<string> {
    return (await this.settings()).digestTime;
  }

  /* ───────────────────────── общие шаги ───────────────────────── */

  private cardView(r: Request, now: Date): CardView {
    return {
      request: r,
      editorUrl: this.d.links.form(r.requestId, 'editor'),
      overdue: r.status === 'with_editor' && !!r.dueAt && r.dueAt < now,
      ...(r.dueAt ? { dueLabel: formatShortDate(r.dueAt, this.d.tz) } : {}),
    };
  }

  /** Обновляет карточку в теме «Сайт». Черновики редактору не показываем. */
  private async refreshCard(r: Request): Promise<Request> {
    if (r.cardMessageId === undefined && (r.status === 'draft' || r.status === 'cancelled')) {
      return r;
    }
    try {
      const id = await this.d.notifier.upsertCard(this.cardView(r, this.d.clock.now()));
      if (id !== undefined && id !== r.cardMessageId) {
        const next = { ...r, cardMessageId: id };
        await this.d.repo.updateRequest(next);
        return next;
      }
    } catch (error) {
      await this.report('Не удалось обновить карточку заявки', error, r.requestId);
    }
    return r;
  }

  private async report(what: string, error: unknown, requestId?: string): Promise<void> {
    this.d.log.error(what, { requestId, error });
    try {
      await this.d.notifier.alert(
        `⚠️ ${what}${requestId ? ` (${requestId})` : ''}: ${String(error)}`,
      );
    } catch (e) {
      this.d.log.error('Не удалось отправить тревогу', { error: e });
    }
  }

  private async tell(person: PersonRow | undefined, message: OutMessage, requestId?: string) {
    if (person?.telegramUserId === undefined) return;
    try {
      await this.d.notifier.sendToUser(person.telegramUserId, message);
    } catch (error) {
      await this.report('Не удалось написать сотруднику', error, requestId);
    }
  }

  private async noteEditors(r: Request, text: string, attachment?: Attachment) {
    if (r.cardMessageId === undefined) return;
    try {
      await this.d.notifier.noteToEditors(r, text, attachment);
    } catch (error) {
      await this.report('Не удалось написать в тему «Сайт»', error, r.requestId);
    }
  }

  private async history(events: Omit<HistoryEvent, 'at'>[]): Promise<void> {
    const at = this.d.clock.now();
    await this.d.repo.appendHistory(events.map((e) => ({ at, ...e })));
  }

  /** Переводит заявку по действию, пишет историю и обновляет карточку. */
  private async act(
    r: Request,
    action: Action,
    actor: Actor,
    opts: { patch?: (next: Request) => void; details?: string } = {},
  ): Promise<Request> {
    const { settings, calendar, now } = await this.env();
    const next = applyTransition(r, action, actor, now, calendar, settings);
    opts.patch?.(next);
    await this.d.repo.updateRequest(next);
    await this.history([
      {
        requestId: r.requestId,
        personId: r.personId,
        event: ACTION_EVENTS[action],
        from: STATUS_LABELS[r.status],
        to: STATUS_LABELS[next.status],
        actor: actor.name,
        ...(opts.details ? { details: opts.details } : {}),
      },
    ]);
    return this.refreshCard(next);
  }

  private async createRequest(input: {
    type: RequestType;
    person: PersonRow;
    initiator: Request['initiator'];
    status: 'draft' | 'with_editor';
    actor: Actor;
    details?: string;
  }): Promise<Request> {
    const { settings, calendar, now } = await this.env();
    const requestId = await this.d.repo.nextRequestId();
    const r: Request = {
      requestId,
      type: input.type,
      personId: input.person.personId,
      fullName: input.person.fullName,
      status: input.status,
      initiator: input.initiator,
      createdAt: now,
      statusSince: now,
      updatedAt: now,
      fields: {},
    };
    if (input.status === 'with_editor') r.submittedAt = now;
    const due = dueFor(input.status, r, now, calendar, settings);
    if (due) r.dueAt = due;
    await this.d.repo.insertRequest(r);
    await this.history([
      {
        requestId,
        personId: r.personId,
        event: `создана: ${REQUEST_TYPE_LABELS[input.type].toLowerCase()}`,
        to: STATUS_LABELS[input.status],
        actor: input.actor.name,
        ...(input.details ? { details: input.details } : {}),
      },
    ]);
    return this.refreshCard(r);
  }

  /** Закрытие заявки: страница в Profiles становится подтверждённой версией. */
  private async finalize(r: Request, actor: Actor): Promise<void> {
    const now = this.d.clock.now();
    const [people, profiles] = await Promise.all([
      this.d.repo.listPeople(),
      this.d.repo.listProfiles(),
    ]);
    const person = people.find((p) => p.personId === r.personId);
    const before = profiles.find((p) => p.personId === r.personId);
    const after = applyToProfile(
      before,
      r,
      person ?? { personId: r.personId, fullName: r.fullName },
      now,
    );
    await this.d.repo.saveProfile(after);
    const events: Omit<HistoryEvent, 'at'>[] = [
      {
        requestId: r.requestId,
        personId: r.personId,
        event: r.type === 'archive' ? 'страница в архиве' : 'страница обновлена',
        actor: actor.name,
        details: JSON.stringify(profileDiff(before, after)),
      },
    ];
    // Человек сам попросил убрать страницу — отмечаем в реестре, иначе сверка вернёт её обратно
    if (r.type === 'archive' && r.initiator === 'person' && person?.publish) {
      await this.d.repo.patchPerson(r.personId, {
        publish: false,
        note: appendNote(
          person.note,
          `${formatDate(now, this.d.tz)}: сам снял страницу (${r.requestId})`,
        ),
      });
      events.push({
        requestId: r.requestId,
        personId: r.personId,
        event: 'реестр: публикация выключена по просьбе человека',
        actor: actor.name,
      });
    }
    await this.history(events);
  }

  private async requesterContext(telegramUserId: number, requestId: string) {
    const person = await this.identifyUnlocked(telegramUserId);
    const r = await this.d.repo.getRequest(requestId);
    if (!r || r.personId !== person.personId || !hasRequester(r)) {
      throw new UserError('Это не ваша заявка.');
    }
    const actor: Actor = { kind: 'requester', id: telegramUserId, name: person.fullName };
    return { person, r, actor };
  }

  private async getRequestOrFail(requestId: string): Promise<Request> {
    const r = await this.d.repo.getRequest(requestId);
    if (!r) throw new UserError(`Заявка ${requestId} не найдена.`);
    return r;
  }

  /* ───────────────────────── реестр ───────────────────────── */

  /**
   * Сверка с реестром. People говорит, кто должен быть на сайте;
   * бот создаёт заявки, чтобы сайт пришёл к этому состоянию:
   * новая страница, снятие, отзыв лишних заявок, ссылки-приглашения.
   */
  syncRegistry(): Promise<SyncReport> {
    return this.lock.run(async () => {
      const report: SyncReport = {
        assignedIds: [],
        created: [],
        archived: [],
        withdrawn: [],
        invites: [],
        problems: [],
      };
      const { settings, now } = await this.env();
      const { people, profiles, requests } = await this.d.repo.snapshot();

      // 1. ID для новых строк
      const used = new Set(people.map((p) => p.personId).filter(Boolean));
      let max = Math.max(0, ...[...used].map(parsePersonNumber));
      for (const p of people) {
        if (p.personId || !p.fullName) continue;
        max += 1;
        const id = formatPersonId(max);
        await this.d.repo.assignPersonId(p.ref, p.fullName, id);
        p.personId = id;
        used.add(id);
        report.assignedIds.push(id);
        await this.history([
          { personId: id, event: 'реестр: присвоен ID', actor: 'бот', details: p.fullName },
        ]);
      }

      const seen = new Map<string, number>();
      for (const p of people) if (p.personId) seen.set(p.personId, (seen.get(p.personId) ?? 0) + 1);
      for (const [id, n] of seen)
        if (n > 1) report.problems.push(`ID ${id} стоит в ${n} строках People`);

      const profileOf = new Map(profiles.map((p) => [p.personId, p]));
      const openOf = new Map<string, Request>();
      for (const r of requests) if (isOpen(r.status)) openOf.set(r.personId, r);

      for (const p of people) {
        if (!p.personId || !p.fullName || (seen.get(p.personId) ?? 0) > 1) continue;
        const desired = p.status === 'active' && p.publish;
        const actual = profileOf.get(p.personId)?.publication === 'published';
        let open = openOf.get(p.personId);

        if (desired && !actual) {
          if (!open) {
            const r = await this.createRequest({
              type: 'create',
              person: p,
              initiator: 'registry',
              status: 'draft',
              actor: REGISTRY_ACTOR,
            });
            report.created.push(r.requestId);
            if (p.telegramUserId !== undefined) {
              await this.tell(
                p,
                formInvite(r, this.d.links.form(r.requestId, 'requester')),
                r.requestId,
              );
            }
          }
        } else if (!desired && actual) {
          if (open && open.type !== 'archive') {
            await this.withdraw(open, 'человек снят с публикации в реестре');
            report.withdrawn.push(open.requestId);
            open = undefined;
          }
          if (!open) {
            const r = await this.createRequest({
              type: 'archive',
              person: p,
              initiator: 'registry',
              status: 'with_editor',
              actor: REGISTRY_ACTOR,
              details: p.status === 'left' ? 'ушёл из центра' : 'не публикуем',
            });
            report.archived.push(r.requestId);
          }
        } else if (desired && actual) {
          if (open?.type === 'archive' && open.initiator === 'registry') {
            await this.withdraw(open, 'реестр вернул публикацию');
            report.withdrawn.push(open.requestId);
          }
        } else if (open?.type === 'create') {
          await this.withdraw(open, 'реестр отменил публикацию');
          report.withdrawn.push(open.requestId);
        }

        // Ссылки-приглашения: нужны тем, кто на сайте и ещё не подключился к боту
        const needsInvite = desired && p.telegramUserId === undefined;
        if (needsInvite && (!p.inviteCode || !p.inviteExpiresAt || p.inviteExpiresAt < now)) {
          await this.d.repo.patchPerson(p.personId, {
            inviteCode: randomCode(),
            inviteExpiresAt: new Date(now.getTime() + settings.inviteDays * DAY_MS),
          });
          report.invites.push(p.personId);
        } else if (!needsInvite && p.inviteCode) {
          await this.d.repo.patchPerson(p.personId, { inviteCode: null, inviteExpiresAt: null });
        }
      }

      this.lastProblems = report.problems;
      return report;
    });
  }

  private async withdraw(r: Request, reason: string): Promise<void> {
    const next = await this.act(r, 'withdraw', REGISTRY_ACTOR, {
      patch: (n) => {
        n.closeReason = reason;
      },
      details: reason,
    });
    await this.noteEditors(next, `Заявка отозвана: ${reason}.`);
  }

  /* ───────────────────────── привязка Telegram ───────────────────────── */

  bind(code: string, user: TelegramUser): Promise<BindResult> {
    return this.lock.run(async () => {
      const now = this.d.clock.now();
      const people = await this.d.repo.listPeople();
      const mine = people.find((p) => p.telegramUserId === user.id);
      const person = people.find((p) => p.inviteCode && p.inviteCode === code);

      if (!person) {
        if (mine && mine.status === 'active') return { person: mine, alreadyBound: true };
        throw new UserError(
          'Ссылка недействительна или уже использована. Попросите новую у администратора центра.',
        );
      }
      if (person.status !== 'active' || !person.publish) {
        throw new UserError('Эта ссылка больше не действует. Обратитесь к администратору центра.');
      }
      if (person.inviteExpiresAt && person.inviteExpiresAt < now) {
        throw new UserError('Срок ссылки истёк. Попросите новую у администратора центра.');
      }
      if (mine && mine.personId !== person.personId) {
        throw new UserError(
          'Этот Telegram уже привязан к другому человеку. Обратитесь к администратору центра.',
        );
      }

      await this.d.repo.patchPerson(person.personId, {
        telegramUserId: user.id,
        telegramUsername: user.username ?? null,
        boundAt: now,
        inviteCode: null,
        inviteExpiresAt: null,
      });
      await this.history([
        {
          personId: person.personId,
          event: 'Telegram привязан',
          actor: user.name,
          ...(user.username ? { details: `@${user.username}` } : {}),
        },
      ]);
      const bound: PersonRow = { ...person, telegramUserId: user.id, boundAt: now };
      if (user.username) bound.telegramUsername = user.username;
      delete bound.inviteCode;
      delete bound.inviteExpiresAt;

      const requests = await this.d.repo.listRequests();
      const draft = requests.find(
        (r) => r.personId === person.personId && r.type === 'create' && r.status === 'draft',
      );
      return {
        person: bound,
        alreadyBound: false,
        ...(draft
          ? {
              pending: {
                request: draft,
                message: formInvite(draft, this.d.links.form(draft.requestId, 'requester')),
              },
            }
          : {}),
      };
    });
  }

  private async identifyUnlocked(telegramUserId: number): Promise<PersonRow> {
    const people = await this.d.repo.listPeople();
    const person = people.find((p) => p.telegramUserId === telegramUserId);
    if (!person) {
      throw new UserError(
        'Я вас пока не знаю. Попросите у администратора центра ссылку-приглашение.',
      );
    }
    if (person.status !== 'active') {
      throw new UserError('Доступ закрыт: в реестре вы отмечены как ушедший сотрудник.');
    }
    return person;
  }

  /** Кто пишет боту. Каждый раз сверяется с реестром: отвязка и уход действуют сразу. */
  identify(telegramUserId: number): Promise<PersonRow> {
    return this.lock.run(() => this.identifyUnlocked(telegramUserId));
  }

  /* ───────────────────────── заявитель ───────────────────────── */

  startUpdate(telegramUserId: number): Promise<StartUpdateResult> {
    return this.lock.run(async () => {
      const person = await this.identifyUnlocked(telegramUserId);
      const { profiles, requests } = await this.d.repo.snapshot();
      const open = requests.find((r) => r.personId === person.personId && isOpen(r.status));
      if (open) {
        if (REQUESTER_EDITABLE.includes(open.status)) {
          const url = this.d.links.form(open.requestId, 'requester');
          const message =
            open.status === 'needs_info' && open.editorNote
              ? needInfoMessage(open, open.editorNote, url)
              : formInvite(open, url);
          return { kind: 'form', request: open, message, created: false };
        }
        if (open.status === 'review') {
          const profile = profiles.find((p) => p.personId === person.personId);
          const due = open.dueAt ? formatShortDate(open.dueAt, this.d.tz) : '—';
          return {
            kind: 'review',
            request: open,
            message: publishedMessage(open, open.pageUrl ?? profile?.pageUrl, due),
          };
        }
        return { kind: 'waiting', request: open };
      }
      const profile = profiles.find((p) => p.personId === person.personId);
      if (profile?.publication !== 'published') {
        throw new UserError(
          'Вашей страницы на сайте пока нет. Новые страницы создаются по решению администратора центра — бот пришлёт анкету сам.',
        );
      }
      const r = await this.createRequest({
        type: 'update',
        person,
        initiator: 'person',
        status: 'draft',
        actor: { kind: 'requester', id: telegramUserId, name: person.fullName },
      });
      return {
        kind: 'form',
        request: r,
        message: formInvite(r, this.d.links.form(r.requestId, 'requester')),
        created: true,
      };
    });
  }

  requestArchive(telegramUserId: number): Promise<Request> {
    return this.lock.run(async () => {
      const person = await this.identifyUnlocked(telegramUserId);
      const { profiles, requests } = await this.d.repo.snapshot();
      const profile = profiles.find((p) => p.personId === person.personId);
      if (profile?.publication !== 'published') {
        throw new UserError('Вашей страницы на сайте сейчас нет — снимать нечего.');
      }
      const open = requests.find((r) => r.personId === person.personId && isOpen(r.status));
      if (open) {
        throw new UserError(
          `Сначала завершите или отмените заявку ${open.requestId} («${STATUS_LABELS[open.status]}»).`,
        );
      }
      return this.createRequest({
        type: 'archive',
        person,
        initiator: 'person',
        status: 'with_editor',
        actor: { kind: 'requester', id: telegramUserId, name: person.fullName },
        details: 'по просьбе человека',
      });
    });
  }

  myRequests(telegramUserId: number): Promise<Request[]> {
    return this.lock.run(async () => {
      const person = await this.identifyUnlocked(telegramUserId);
      const requests = await this.d.repo.listRequests();
      return requests
        .filter((r) => r.personId === person.personId && hasRequester(r))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, 5);
    });
  }

  confirm(telegramUserId: number, requestId: string): Promise<Request> {
    return this.lock.run(async () => {
      const { r, actor } = await this.requesterContext(telegramUserId, requestId);
      const next = await this.act(r, 'confirm', actor, {
        patch: (n) => {
          n.closeReason = 'подтверждено заявителем';
        },
      });
      await this.finalize(next, actor);
      await this.noteEditors(next, 'Заявитель подтвердил публикацию ✅');
      return next;
    });
  }

  askFix(
    telegramUserId: number,
    requestId: string,
  ): Promise<{ request: Request; message: OutMessage }> {
    return this.lock.run(async () => {
      const { r, actor } = await this.requesterContext(telegramUserId, requestId);
      const next = await this.act(r, 'askFix', actor);
      await this.noteEditors(next, 'Заявитель просит правку — ждём исправленную анкету.');
      return {
        request: next,
        message: fixMessage(next, this.d.links.form(next.requestId, 'requester')),
      };
    });
  }

  cancel(telegramUserId: number, requestId: string): Promise<Request> {
    return this.lock.run(async () => {
      const { person, r, actor } = await this.requesterContext(telegramUserId, requestId);
      const next = await this.act(r, 'cancel', actor, {
        patch: (n) => {
          n.closeReason = 'отменена заявителем';
        },
      });
      await this.noteEditors(next, 'Заявитель отменил заявку.');
      // Отказ от новой страницы: фиксируем в реестре, иначе сверка создаст её снова
      if (r.type === 'create' && r.initiator === 'registry' && person.publish) {
        const now = this.d.clock.now();
        await this.d.repo.patchPerson(person.personId, {
          publish: false,
          note: appendNote(
            person.note,
            `${formatDate(now, this.d.tz)}: отказался от страницы (${r.requestId})`,
          ),
        });
        await this.history([
          {
            requestId: r.requestId,
            personId: person.personId,
            event: 'реестр: публикация выключена по просьбе человека',
            actor: actor.name,
          },
        ]);
      }
      return next;
    });
  }

  /* ───────────────────────── редактор ───────────────────────── */

  take(requestId: string, editor: Actor): Promise<Request> {
    return this.lock.run(async () => {
      const r = await this.getRequestOrFail(requestId);
      if (r.assigneeId !== undefined && r.assigneeId === editor.id) return r;
      return this.act(r, 'take', editor);
    });
  }

  /** Проверяет, что редактор может работать с заявкой (не чужая, нужный статус). */
  checkEditor(requestId: string, action: 'needInfo' | 'publish' | 'reject', editor: Actor) {
    return this.lock.run(async () => {
      const r = await this.getRequestOrFail(requestId);
      checkTransition(r, action, editor);
      return r;
    });
  }

  needInfo(requestId: string, editor: Actor, question: string): Promise<Request> {
    return this.lock.run(async () => {
      const text = normalizeText(question);
      if (!text) throw new UserError('Напишите, что нужно уточнить.');
      const r = await this.getRequestOrFail(requestId);
      const next = await this.act(r, 'needInfo', editor, {
        patch: (n) => {
          n.editorNote = text;
        },
        details: text,
      });
      const person = (await this.d.repo.listPeople()).find((p) => p.personId === r.personId);
      await this.tell(
        person,
        needInfoMessage(next, text, this.d.links.form(next.requestId, 'requester')),
        next.requestId,
      );
      return next;
    });
  }

  reject(requestId: string, editor: Actor, reason: string): Promise<Request> {
    return this.lock.run(async () => {
      const text = normalizeText(reason);
      if (!text) throw new UserError('Напишите причину отказа.');
      const r = await this.getRequestOrFail(requestId);
      const next = await this.act(r, 'reject', editor, {
        patch: (n) => {
          n.editorNote = text;
          n.closeReason = `отклонена: ${text}`;
        },
        details: text,
      });
      if (hasRequester(next)) {
        const person = (await this.d.repo.listPeople()).find((p) => p.personId === r.personId);
        await this.tell(person, rejectedMessage(next, text), next.requestId);
      }
      return next;
    });
  }

  /**
   * «Опубликовано». Для новой страницы нужен её адрес; для обновления и снятия
   * он уже известен. Проверка сайта не блокирует, а только предупреждает.
   */
  async publish(requestId: string, editor: Actor, url?: string): Promise<PublishResult> {
    const pre = await this.lock.run(async () => {
      const r = await this.getRequestOrFail(requestId);
      checkTransition(r, 'publish', editor);
      const profile = (await this.d.repo.listProfiles()).find((p) => p.personId === r.personId);
      return { r, profile };
    });
    const pageUrl = normalizeText(url) || pre.r.pageUrl || pre.profile?.pageUrl;
    if (pre.r.type === 'create' && !normalizeText(url) && !pre.r.pageUrl) {
      return { kind: 'needUrl', request: pre.r };
    }
    if (pageUrl && this.d.site && !this.d.site.isSiteUrl(pageUrl)) {
      throw new UserError('Нужна ссылка на страницу сайта центра, например https://dh.itmo.ru/…');
    }
    const warning = pageUrl ? await this.checkSite(pre.r.type, pageUrl) : undefined;

    return this.lock.run(async () => {
      const r = await this.getRequestOrFail(requestId);
      const next = await this.act(r, 'publish', editor, {
        patch: (n) => {
          if (pageUrl) n.pageUrl = pageUrl;
          if (n.status === 'done') n.closeReason = 'страница снята';
        },
        ...(pageUrl ? { details: pageUrl } : {}),
      });
      if (warning) await this.noteEditors(next, `⚠️ ${warning}`);
      if (next.status === 'done') {
        await this.finalize(next, editor);
      } else {
        const person = (await this.d.repo.listPeople()).find((p) => p.personId === r.personId);
        const due = next.dueAt ? formatShortDate(next.dueAt, this.d.tz) : '—';
        await this.tell(person, publishedMessage(next, pageUrl, due), next.requestId);
      }
      return { kind: 'done', request: next, ...(warning ? { warning } : {}) };
    });
  }

  private async checkSite(type: RequestType, url: string): Promise<string | undefined> {
    if (!this.d.site) return undefined;
    let status: number;
    try {
      status = await this.d.site.status(url);
    } catch {
      status = 0;
    }
    if (type === 'archive') {
      return status === 200
        ? `Страница ${url} всё ещё открывается — проверьте, что её сняли.`
        : undefined;
    }
    if (status === 200) return undefined;
    return status === 0
      ? `Не удалось открыть ${url} — проверьте публикацию.`
      : `Страница ${url} отвечает кодом ${status} — проверьте публикацию.`;
  }

  /* ───────────────────────── форма ───────────────────────── */

  private async formModel(requestId: string, role: LinkRole): Promise<FormModel> {
    const r = await this.getRequestOrFail(requestId);
    const [people, profiles] = await Promise.all([
      this.d.repo.listPeople(),
      this.d.repo.listProfiles(),
    ]);
    const person = people.find((p) => p.personId === r.personId);
    const current = profiles.find((p) => p.personId === r.personId);
    let editable = false;
    let notice: string | undefined;

    if (r.type === 'archive') {
      notice = 'Это заявка на снятие страницы: заполнять ничего не нужно.';
    } else if (role === 'requester') {
      if (person?.status !== 'active') {
        notice = 'Доступ закрыт: в реестре вы отмечены как ушедший сотрудник.';
      } else if (REQUESTER_EDITABLE.includes(r.status)) {
        editable = true;
        if (r.status === 'needs_info' && r.editorNote) {
          notice = `Редактор просит: «${r.editorNote}»`;
        }
      } else if (r.status === 'with_editor') {
        notice = 'Заявка у редактора. Изменить её можно, если редактор запросит уточнение.';
      } else if (r.status === 'review') {
        notice =
          'Страница опубликована. Если нужна правка, нажмите «Нужна правка» в сообщении бота.';
      } else {
        notice = `Заявка закрыта: «${STATUS_LABELS[r.status]}».`;
      }
    } else if (r.status === 'with_editor') {
      editable = true;
      notice =
        'Правки сохранятся в заявке и попадут в таблицу после закрытия. Опубликовав страницу в Tilda, нажмите «Опубликовано» в карточке.';
    } else {
      notice = `Заявка в статусе «${STATUS_LABELS[r.status]}», редактировать её сейчас нельзя.`;
    }

    return {
      request: r,
      role,
      editable,
      ...(notice ? { notice } : {}),
      values: formValues(r, current),
      ...(current ? { current } : {}),
      hasNewPhoto: !!r.photo,
      hasCurrentPhoto: !!current?.photo,
    };
  }

  openForm(requestId: string, role: LinkRole): Promise<FormModel> {
    return this.lock.run(() => this.formModel(requestId, role));
  }

  /** Отправка анкеты заявителем. */
  submitForm(requestId: string, input: FormInput): Promise<SubmitResult> {
    return this.lock.run(async () => {
      const model = await this.formModel(requestId, 'requester');
      if (!model.editable)
        throw new UserError(model.notice ?? 'Эту заявку сейчас нельзя изменить.');
      const r = model.request;
      const person = (await this.d.repo.listPeople()).find((p) => p.personId === r.personId);
      if (!person || person.telegramUserId === undefined) {
        throw new UserError('Сначала подключитесь к боту по ссылке-приглашению.');
      }

      const fail = (errors: Partial<Record<FormErrorKey, string>>): SubmitResult => ({
        ok: false,
        errors,
        model: { ...model, values: { ...model.values, ...cleanFields(input.fields) } },
      });

      let photoInfo: ReturnType<typeof inspectPhoto> | undefined;
      if (input.photo?.byteLength) {
        try {
          photoInfo = inspectPhoto(input.photo);
        } catch (e) {
          if (e instanceof PhotoError) return fail({ photo: e.message });
          throw e;
        }
      }

      const check = checkSubmission(
        r.type,
        { fields: input.fields, hasNewPhoto: !!photoInfo || !!r.photo, comment: input.comment },
        model.current,
        { allowCommentOnly: r.status === 'needs_info' },
      );
      if (hasErrors(check)) return fail(check.errors);

      const photoRef =
        photoInfo && input.photo
          ? await this.d.photos.save({
              personId: r.personId,
              requestId: r.requestId,
              data: input.photo,
              mimeType: photoInfo.mimeType,
              ext: photoInfo.ext,
            })
          : r.photo;
      const comment = normalizeText(input.comment);
      const wasNeedsInfo = r.status === 'needs_info';

      const next = await this.act(
        r,
        'submit',
        { kind: 'requester', id: person.telegramUserId, name: person.fullName },
        {
          patch: (n) => {
            n.fields = check.fields;
            if (photoRef) n.photo = photoRef;
            if (comment) n.requesterNote = comment;
            else delete n.requesterNote;
          },
          details: changedLabels({
            ...r,
            fields: check.fields,
            ...(photoRef ? { photo: photoRef } : {}),
          }).join(', '),
        },
      );
      if (wasNeedsInfo) {
        await this.noteEditors(
          next,
          `Заявитель дополнил заявку.${comment ? `\nКомментарий: ${comment}` : ''}`,
        );
      }
      if (photoInfo && input.photo) {
        await this.noteEditors(next, `${PHOTO_LABEL} из заявки ${next.requestId}`, {
          filename: `${next.personId}_${next.requestId}.${photoInfo.ext}`,
          data: input.photo,
          mimeType: photoInfo.mimeType,
        });
      }
      return { ok: true, request: next };
    });
  }

  /** Правка текста редактором перед публикацией. */
  saveEditorForm(requestId: string, input: FormInput): Promise<SubmitResult> {
    return this.lock.run(async () => {
      const model = await this.formModel(requestId, 'editor');
      if (!model.editable)
        throw new UserError(model.notice ?? 'Эту заявку сейчас нельзя изменить.');
      const r = model.request;
      const fail = (errors: Partial<Record<FormErrorKey, string>>): SubmitResult => ({
        ok: false,
        errors,
        model: { ...model, values: { ...model.values, ...cleanFields(input.fields) } },
      });

      let photoInfo: ReturnType<typeof inspectPhoto> | undefined;
      if (input.photo?.byteLength) {
        try {
          photoInfo = inspectPhoto(input.photo);
        } catch (e) {
          if (e instanceof PhotoError) return fail({ photo: e.message });
          throw e;
        }
      }
      const check = checkSubmission(
        r.type,
        { fields: input.fields, hasNewPhoto: !!photoInfo || !!r.photo },
        model.current,
        { allowCommentOnly: true },
      );
      delete check.errors.form;
      if (hasErrors(check)) return fail(check.errors);

      const changed = (Object.keys({ ...r.fields, ...check.fields }) as FieldKey[]).filter(
        (k) => r.fields[k] !== check.fields[k],
      );
      if (!changed.length && !photoInfo) return { ok: true, request: r };

      const photoRef =
        photoInfo && input.photo
          ? await this.d.photos.save({
              personId: r.personId,
              requestId: r.requestId,
              data: input.photo,
              mimeType: photoInfo.mimeType,
              ext: photoInfo.ext,
            })
          : r.photo;
      const labels = changed.map((k) => FIELD_BY_KEY[k].label);
      if (photoInfo) labels.push(PHOTO_LABEL);
      const next = await this.act(
        r,
        'edit',
        { kind: 'editor', name: 'редактор (форма)' },
        {
          patch: (n) => {
            n.fields = check.fields;
            if (photoRef) n.photo = photoRef;
          },
          details: labels.join(', '),
        },
      );
      await this.noteEditors(next, `Редактор поправил: ${labels.join(', ')}.`);
      return { ok: true, request: next };
    });
  }

  /** Фото для формы: новое из заявки или текущее со страницы. */
  photo(
    requestId: string,
    which: 'new' | 'current',
  ): Promise<{ ref: string; stored?: StoredPhoto } | undefined> {
    return this.lock.run(async () => {
      const r = await this.getRequestOrFail(requestId);
      let ref = r.photo;
      if (which === 'current') {
        const profile = (await this.d.repo.listProfiles()).find((p) => p.personId === r.personId);
        ref = profile?.photo;
      }
      if (!ref) return undefined;
      const stored = await this.d.photos.load(ref);
      return stored ? { ref, stored } : { ref };
    });
  }

  /* ───────────────────────── таймеры ───────────────────────── */

  /** Каждые несколько минут: автоподтверждение и истёкшие черновики. */
  tick(): Promise<void> {
    return this.lock.run(async () => {
      const now = this.d.clock.now();
      const [requests, people] = await Promise.all([
        this.d.repo.listRequests(),
        this.d.repo.listPeople(),
      ]);
      for (const r of requests) {
        if (!r.dueAt || r.dueAt > now) continue;
        try {
          if (r.status === 'review') {
            const next = await this.act(r, 'autoConfirm', SYSTEM_ACTOR, {
              patch: (n) => {
                n.closeReason = 'подтверждено автоматически';
              },
            });
            await this.finalize(next, SYSTEM_ACTOR);
            await this.noteEditors(next, 'Заявитель не ответил — заявка закрыта автоматически.');
            await this.tell(
              people.find((p) => p.personId === r.personId),
              autoConfirmedMessage(next),
              next.requestId,
            );
          } else if (r.status === 'draft' && r.type === 'update') {
            await this.act(r, 'expire', SYSTEM_ACTOR, {
              patch: (n) => {
                n.closeReason = 'черновик не отправлен';
              },
            });
          }
        } catch (error) {
          await this.report('Сбой таймера заявки', error, r.requestId);
        }
      }
    });
  }

  /** Раз в рабочий день: напоминания заявителям и сводка в тему «Сайт». */
  daily(): Promise<{ digest?: string; reminders: string[] }> {
    return this.lock.run(async () => {
      const { settings, calendar, now } = await this.env();
      const reminders: string[] = [];
      if (!calendar.isWorkingDay(now)) return { reminders };
      const { people, profiles, requests } = await this.d.repo.snapshot();
      const personOf = new Map(people.map((p) => [p.personId, p]));

      for (const r of requests) {
        const person = personOf.get(r.personId);
        if (person?.telegramUserId === undefined || !hasRequester(r)) continue;
        const waitingForm =
          r.status === 'needs_info' || (r.status === 'draft' && r.type === 'create');
        if (waitingForm && r.dueAt && r.dueAt <= now) {
          await this.tell(
            person,
            reminderMessage(r, this.d.links.form(r.requestId, 'requester')),
            r.requestId,
          );
          await this.d.repo.updateRequest({
            ...r,
            lastReminderAt: now,
            dueAt: calendar.addWorkingDays(now, settings.reminderDays),
            updatedAt: now,
          });
          reminders.push(r.requestId);
        } else if (
          r.status === 'review' &&
          r.dueAt &&
          !r.lastReminderAt &&
          calendar.workingDaysBetween(now, r.dueAt) <= 1
        ) {
          const pageUrl = r.pageUrl ?? profiles.find((p) => p.personId === r.personId)?.pageUrl;
          await this.tell(
            person,
            reviewReminder(r, pageUrl, formatShortDate(r.dueAt, this.d.tz)),
            r.requestId,
          );
          await this.d.repo.updateRequest({ ...r, lastReminderAt: now, updatedAt: now });
          reminders.push(r.requestId);
        }
      }

      const digest = buildDigest({
        requests: await this.d.repo.listRequests(),
        people,
        now,
        calendar,
        problems: this.lastProblems,
      });
      if (digest) {
        try {
          await this.d.notifier.postToOps(digest);
        } catch (error) {
          await this.report('Не удалось отправить сводку', error);
        }
      }
      return { ...(digest ? { digest } : {}), reminders };
    });
  }
}

function cleanFields(fields: Partial<Record<FieldKey, string>>): Partial<Record<FieldKey, string>> {
  const out: Partial<Record<FieldKey, string>> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (k in FIELD_BY_KEY && typeof v === 'string') out[k as FieldKey] = v;
  }
  return out;
}

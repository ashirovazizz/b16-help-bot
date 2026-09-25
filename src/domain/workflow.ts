import type { WorkCalendar } from '../core/calendar.js';
import { UserError } from '../core/errors.js';
import { DAY_MS } from '../core/time.js';
import { isOpen, type Request, type RequestStatus, type Settings, STATUS_LABELS } from './model.js';

/**
 * Жизненный цикл заявки.
 *
 *   Черновик ─► У редактора ⇄ Нужны данные
 *                   │
 *                   ├─► На проверке ─► Готово        (создание, обновление)
 *                   │        └─► Нужны данные        (заявитель просит правку)
 *                   ├─► Готово                       (снятие)
 *                   └─► Отклонена
 *   Отменить можно всё, что ещё не опубликовано.
 */

export type Action =
  | 'submit'
  | 'take'
  | 'edit'
  | 'needInfo'
  | 'publish'
  | 'reject'
  | 'confirm'
  | 'autoConfirm'
  | 'askFix'
  | 'cancel'
  | 'expire'
  | 'withdraw';

export type ActorKind = 'requester' | 'editor' | 'system' | 'registry';

export interface Actor {
  kind: ActorKind;
  /** Telegram ID, если действие пришло из Telegram */
  id?: number;
  name: string;
}

export const SYSTEM_ACTOR: Actor = { kind: 'system', name: 'бот' };
export const REGISTRY_ACTOR: Actor = { kind: 'registry', name: 'реестр' };

interface Rule {
  from: readonly RequestStatus[];
  to: (r: Request) => RequestStatus;
  actors: readonly ActorKind[];
  /** Действие закрепляет заявку за редактором; чужую заявку трогать нельзя */
  assign?: boolean;
}

const same = (r: Request) => r.status;

export const RULES: Record<Action, Rule> = {
  submit: { from: ['draft', 'needs_info'], to: () => 'with_editor', actors: ['requester'] },
  take: { from: ['with_editor'], to: same, actors: ['editor'], assign: true },
  edit: { from: ['with_editor'], to: same, actors: ['editor'] },
  needInfo: { from: ['with_editor'], to: () => 'needs_info', actors: ['editor'], assign: true },
  publish: {
    from: ['with_editor'],
    to: (r) => (r.type === 'archive' ? 'done' : 'review'),
    actors: ['editor'],
    assign: true,
  },
  reject: { from: ['with_editor'], to: () => 'rejected', actors: ['editor'], assign: true },
  confirm: { from: ['review'], to: () => 'done', actors: ['requester'] },
  autoConfirm: { from: ['review'], to: () => 'done', actors: ['system'] },
  askFix: { from: ['review'], to: () => 'needs_info', actors: ['requester'] },
  cancel: {
    from: ['draft', 'needs_info', 'with_editor'],
    to: () => 'cancelled',
    actors: ['requester'],
  },
  expire: { from: ['draft'], to: () => 'cancelled', actors: ['system'] },
  withdraw: {
    from: ['draft', 'needs_info', 'with_editor', 'review'],
    to: () => 'cancelled',
    actors: ['registry'],
  },
};

export const ACTION_EVENTS: Record<Action, string> = {
  submit: 'отправлена редактору',
  take: 'взята в работу',
  edit: 'правка редактора',
  needInfo: 'запрошены данные',
  publish: 'отмечена как опубликованная',
  reject: 'отклонена',
  confirm: 'подтверждена заявителем',
  autoConfirm: 'подтверждена автоматически',
  askFix: 'заявитель попросил правку',
  cancel: 'отменена заявителем',
  expire: 'черновик истёк',
  withdraw: 'отозвана реестром',
};

/** Может ли заявитель действовать по этой заявке (снятие по решению реестра — не его). */
export function hasRequester(r: Request): boolean {
  return !(r.type === 'archive' && r.initiator === 'registry');
}

function notAllowed(r: Request): UserError {
  if (!isOpen(r.status)) {
    return new UserError(`Заявка ${r.requestId} уже закрыта: «${STATUS_LABELS[r.status]}».`);
  }
  return new UserError(
    `Заявка ${r.requestId} сейчас в статусе «${STATUS_LABELS[r.status]}», это действие недоступно.`,
  );
}

export interface Transition {
  status: RequestStatus;
  /** Редактор, за которым закрепляется заявка */
  assign?: { id: number; name: string };
}

export function checkTransition(r: Request, action: Action, actor: Actor): Transition {
  const rule = RULES[action];
  if (!rule.actors.includes(actor.kind)) {
    throw new Error(`Действие ${action} недоступно для роли ${actor.kind}`);
  }
  if (actor.kind === 'requester' && !hasRequester(r)) {
    throw new UserError(`Заявку ${r.requestId} запустил реестр, её ведёт редактор.`);
  }
  if (!rule.from.includes(r.status)) throw notAllowed(r);

  let assign: Transition['assign'];
  if (rule.assign && actor.id !== undefined) {
    if (r.assigneeId !== undefined && r.assigneeId !== actor.id) {
      throw new UserError(`Заявку ${r.requestId} ведёт ${r.assigneeName ?? 'другой редактор'}.`);
    }
    if (r.assigneeId === undefined) assign = { id: actor.id, name: actor.name };
  }
  return { status: rule.to(r), ...(assign ? { assign } : {}) };
}

/** Срок, который начинает течь при входе в статус. */
export function dueFor(
  status: RequestStatus,
  r: Request,
  now: Date,
  calendar: WorkCalendar,
  settings: Settings,
): Date | undefined {
  switch (status) {
    case 'with_editor':
      return calendar.addWorkingDays(now, settings.editorDays);
    case 'needs_info':
      return calendar.addWorkingDays(now, settings.reminderDays);
    case 'review':
      return calendar.addWorkingDays(now, settings.reviewDays);
    case 'draft':
      return r.type === 'update'
        ? new Date(now.getTime() + settings.updateDraftDays * DAY_MS)
        : calendar.addWorkingDays(now, settings.reminderDays);
    default:
      return undefined;
  }
}

/** Применяет действие и возвращает новую версию заявки (исходная не меняется). */
export function applyTransition(
  r: Request,
  action: Action,
  actor: Actor,
  now: Date,
  calendar: WorkCalendar,
  settings: Settings,
): Request {
  const { status, assign } = checkTransition(r, action, actor);
  const next: Request = { ...r, fields: { ...r.fields }, status, updatedAt: now };
  if (assign) {
    next.assigneeId = assign.id;
    next.assigneeName = assign.name;
  }
  if (status !== r.status) {
    next.statusSince = now;
    next.dueAt = dueFor(status, next, now, calendar, settings);
    delete next.lastReminderAt;
  }
  if (action === 'submit') next.submittedAt = now;
  if (action === 'publish') next.publishedAt = now;
  if (!isOpen(status)) {
    next.closedAt = now;
    delete next.dueAt;
  }
  return next;
}

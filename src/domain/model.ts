import type { ProfileFields } from './fields.js';

/* ───── Заявки ───── */

export const REQUEST_TYPES = ['create', 'update', 'archive'] as const;
export type RequestType = (typeof REQUEST_TYPES)[number];

export const REQUEST_TYPE_LABELS: Record<RequestType, string> = {
  create: 'Новая страница',
  update: 'Обновление',
  archive: 'Снятие',
};

export const REQUEST_STATUSES = [
  'draft',
  'with_editor',
  'needs_info',
  'review',
  'done',
  'cancelled',
  'rejected',
] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export const STATUS_LABELS: Record<RequestStatus, string> = {
  draft: 'Черновик',
  with_editor: 'У редактора',
  needs_info: 'Нужны данные',
  review: 'На проверке',
  done: 'Готово',
  cancelled: 'Отменена',
  rejected: 'Отклонена',
};

const OPEN: ReadonlySet<RequestStatus> = new Set(['draft', 'with_editor', 'needs_info', 'review']);

export function isOpen(status: RequestStatus): boolean {
  return OPEN.has(status);
}

/** Чей ход: у каждого открытого статуса ровно один ответственный. */
export type Ball = 'requester' | 'editor';

export function ballOf(status: RequestStatus): Ball | undefined {
  switch (status) {
    case 'draft':
    case 'needs_info':
    case 'review':
      return 'requester';
    case 'with_editor':
      return 'editor';
    default:
      return undefined;
  }
}

export const BALL_LABELS: Record<Ball, string> = { requester: 'заявитель', editor: 'редактор' };

/** Кто запустил заявку: сам сотрудник или сверка с реестром. */
export type Initiator = 'person' | 'registry';

export const INITIATOR_LABELS: Record<Initiator, string> = {
  person: 'сотрудник',
  registry: 'реестр',
};

export interface Request {
  requestId: string;
  type: RequestType;
  personId: string;
  fullName: string;
  status: RequestStatus;
  initiator: Initiator;
  /** Telegram ID и имя редактора, который ведёт заявку */
  assigneeId?: number;
  assigneeName?: string;
  createdAt: Date;
  /** Когда заявка вошла в текущий статус — для «висит N рабочих дней» */
  statusSince: Date;
  submittedAt?: Date;
  publishedAt?: Date;
  closedAt?: Date;
  updatedAt: Date;
  /** Срок текущего шага: для редактора — публикация, для заявителя — напоминание или автоподтверждение */
  dueAt?: Date;
  lastReminderAt?: Date;
  /** Итог закрытия: «подтверждено», «подтверждено автоматически», причина отмены… */
  closeReason?: string;
  /** Предлагаемые значения полей: для обновления — только изменённые */
  fields: ProfileFields;
  /** Новое фото (ссылка на файл в Drive) */
  photo?: string;
  /** Адрес страницы: для новой — появляется при публикации */
  pageUrl?: string;
  requesterNote?: string;
  editorNote?: string;
  /** Карточка заявки в теме «Сайт» */
  cardMessageId?: number;
}

/* ───── Реестр и страницы ───── */

export type PersonStatus = 'active' | 'left';

export const PERSON_STATUS_LABELS: Record<PersonStatus, string> = {
  active: 'работает',
  left: 'ушёл',
};

export interface Person {
  personId: string;
  fullName: string;
  category: string;
  /** Должность в центре — подтверждает владелец реестра */
  orgRole: string;
  status: PersonStatus;
  /** Публикуем ли страницу на сайте */
  publish: boolean;
  note: string;
  telegramUserId?: number;
  telegramUsername?: string;
  boundAt?: Date;
  inviteCode?: string;
  inviteExpiresAt?: Date;
}

export type Publication = 'published' | 'archived' | 'none';

export const PUBLICATION_LABELS: Record<Publication, string> = {
  published: 'опубликована',
  archived: 'в архиве',
  none: 'нет',
};

/** Строка листа Profiles — зеркало страницы на сайте. */
export interface Profile {
  personId: string;
  fullName: string;
  pageUrl?: string;
  publication: Publication;
  fields: ProfileFields;
  photo?: string;
  updatedAt?: Date;
  lastRequestId?: string;
}

/* ───── История ───── */

export interface HistoryEvent {
  at: Date;
  requestId?: string;
  personId?: string;
  event: string;
  from?: string;
  to?: string;
  actor: string;
  details?: string;
}

/* ───── Настройки процесса (лист Settings) ───── */

export interface Settings {
  /** Срок публикации редактором, рабочих дней */
  editorDays: number;
  /** Через сколько рабочих дней молчание заявителя считается подтверждением */
  reviewDays: number;
  /** Через сколько рабочих дней напоминать заявителю */
  reminderDays: number;
  /** Сколько календарных дней живёт неотправленный черновик обновления */
  updateDraftDays: number;
  /** Сколько дней действует ссылка-приглашение */
  inviteDays: number;
  /** Время ежедневной сводки, «ЧЧ:ММ» */
  digestTime: string;
  /** Праздники, «YYYY-MM-DD» */
  holidays: string[];
  /** Перенесённые рабочие выходные, «YYYY-MM-DD» */
  workdays: string[];
}

export const DEFAULT_SETTINGS: Settings = {
  editorDays: 3,
  reviewDays: 2,
  reminderDays: 2,
  updateDraftDays: 14,
  inviteDays: 30,
  digestTime: '10:00',
  holidays: [],
  workdays: [],
};

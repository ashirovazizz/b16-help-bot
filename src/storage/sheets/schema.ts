import { FIELDS, PHOTO_LABEL } from '../../domain/fields.js';

/**
 * Структура книги. Колонки ищутся по заголовкам, поэтому их можно
 * переставлять и добавлять свои — бот чужие колонки не трогает.
 */

export interface ColumnDef {
  header: string;
  /** Ширина колонки в пикселях при создании книги */
  width?: number;
  /** Колонку заполняет бот; люди её не правят */
  bot?: boolean;
  /** Выпадающий список значений */
  options?: readonly string[];
}

export interface SheetDef {
  name: string;
  /** Лист целиком ведёт бот */
  botOwned?: boolean;
  columns: readonly ColumnDef[];
}

export const CATEGORY_OPTIONS = ['сотрудники', 'преподаватели', 'участники проектов'] as const;

export const P = {
  id: 'ID',
  fullName: 'ФИО',
  category: 'Категория',
  orgRole: 'Должность в центре',
  status: 'Статус',
  publish: 'Публикуем на сайте',
  note: 'Примечание',
  telegramId: 'Telegram ID',
  telegram: 'Telegram',
  boundAt: 'Привязан',
  invite: 'Ссылка-приглашение',
  inviteUntil: 'Приглашение до',
} as const;

export const PEOPLE: SheetDef = {
  name: 'People',
  columns: [
    { header: P.id, width: 70 },
    { header: P.fullName, width: 220 },
    { header: P.category, width: 170, options: CATEGORY_OPTIONS },
    { header: P.orgRole, width: 260 },
    { header: P.status, width: 110, options: ['работает', 'ушёл'] },
    { header: P.publish, width: 150, options: ['да', 'нет'] },
    { header: P.note, width: 260 },
    { header: P.telegramId, width: 120, bot: true },
    { header: P.telegram, width: 140, bot: true },
    { header: P.boundAt, width: 140, bot: true },
    { header: P.invite, width: 300, bot: true },
    { header: P.inviteUntil, width: 140, bot: true },
  ],
};

export const PR = {
  id: 'ID',
  fullName: 'ФИО',
  pageUrl: 'Адрес страницы',
  publication: 'Публикация',
  photo: PHOTO_LABEL,
  updatedAt: 'Обновлено',
  lastRequest: 'Заявка',
} as const;

export const PROFILES: SheetDef = {
  name: 'Profiles',
  columns: [
    { header: PR.id, width: 70 },
    { header: PR.fullName, width: 200 },
    { header: PR.pageUrl, width: 240 },
    { header: PR.publication, width: 130, options: ['опубликована', 'в архиве', 'нет'] },
    ...FIELDS.map((f) => ({ header: f.label, width: f.multiline ? 360 : 220 })),
    { header: PR.photo, width: 240 },
    { header: PR.updatedAt, width: 140, bot: true },
    { header: PR.lastRequest, width: 90, bot: true },
  ],
};

export const RQ = {
  id: 'Заявка',
  type: 'Тип',
  personId: 'ID',
  fullName: 'ФИО',
  status: 'Статус',
  ball: 'Чей ход',
  due: 'Срок',
  initiator: 'Инициатор',
  assignee: 'Ведёт',
  createdAt: 'Создана',
  statusSince: 'В статусе с',
  submittedAt: 'Отправлена',
  publishedAt: 'Опубликована',
  closedAt: 'Закрыта',
  closeReason: 'Итог',
  changed: 'Изменено',
  photo: PHOTO_LABEL,
  pageUrl: 'Адрес страницы',
  requesterNote: 'Комментарий заявителя',
  editorNote: 'Комментарий редактора',
  assigneeId: 'Ведёт (Telegram ID)',
  card: 'Карточка',
  reminder: 'Напоминание',
  updatedAt: 'Изменена',
} as const;

export const REQUESTS: SheetDef = {
  name: 'Requests',
  botOwned: true,
  columns: [
    { header: RQ.id, width: 80 },
    { header: RQ.type, width: 130 },
    { header: RQ.personId, width: 60 },
    { header: RQ.fullName, width: 200 },
    { header: RQ.status, width: 120 },
    { header: RQ.ball, width: 100 },
    { header: RQ.due, width: 140 },
    { header: RQ.initiator, width: 100 },
    { header: RQ.assignee, width: 140 },
    { header: RQ.createdAt, width: 140 },
    { header: RQ.statusSince, width: 140 },
    { header: RQ.submittedAt, width: 140 },
    { header: RQ.publishedAt, width: 140 },
    { header: RQ.closedAt, width: 140 },
    { header: RQ.closeReason, width: 200 },
    { header: RQ.changed, width: 200 },
    ...FIELDS.map((f) => ({ header: f.label, width: f.multiline ? 320 : 200 })),
    { header: RQ.photo, width: 240 },
    { header: RQ.pageUrl, width: 240 },
    { header: RQ.requesterNote, width: 240 },
    { header: RQ.editorNote, width: 240 },
    { header: RQ.assigneeId, width: 130 },
    { header: RQ.card, width: 90 },
    { header: RQ.reminder, width: 140 },
    { header: RQ.updatedAt, width: 140 },
  ],
};

export const H = {
  at: 'Время',
  requestId: 'Заявка',
  personId: 'ID',
  event: 'Событие',
  from: 'Было',
  to: 'Стало',
  actor: 'Кто',
  details: 'Подробности',
} as const;

export const HISTORY: SheetDef = {
  name: 'History',
  botOwned: true,
  columns: [
    { header: H.at, width: 140 },
    { header: H.requestId, width: 80 },
    { header: H.personId, width: 60 },
    { header: H.event, width: 260 },
    { header: H.from, width: 120 },
    { header: H.to, width: 120 },
    { header: H.actor, width: 160 },
    { header: H.details, width: 480 },
  ],
};

export const S = { key: 'Параметр', value: 'Значение', hint: 'Пояснение' } as const;

export const SETTINGS: SheetDef = {
  name: 'Settings',
  columns: [
    { header: S.key, width: 300 },
    { header: S.value, width: 140 },
    { header: S.hint, width: 480 },
  ],
};

export const SETTING_KEYS = {
  editorDays: 'Срок публикации, рабочих дней',
  reviewDays: 'Автоподтверждение, рабочих дней',
  reminderDays: 'Напоминание заявителю, рабочих дней',
  updateDraftDays: 'Черновик обновления живёт, дней',
  inviteDays: 'Приглашение действует, дней',
  digestTime: 'Время сводки',
  holiday: 'Праздник',
  workday: 'Рабочий день',
} as const;

export const SETTING_HINTS: Record<keyof typeof SETTING_KEYS, string> = {
  editorDays: 'Сколько рабочих дней у редактора на публикацию после получения анкеты.',
  reviewDays: 'Если заявитель не ответил за этот срок, публикация считается подтверждённой.',
  reminderDays:
    'Через сколько рабочих дней напомнить заявителю о незаполненной анкете или вопросе.',
  updateDraftDays: 'Через сколько календарных дней неотправленный черновик обновления закрывается.',
  inviteDays: 'Сколько дней действует ссылка-приглашение в бота.',
  digestTime: 'Во сколько по рабочим дням бот присылает сводку в тему «Сайт», ЧЧ:ММ.',
  holiday: 'Нерабочий день. Добавляйте по строке на дату в формате ГГГГ-ММ-ДД.',
  workday: 'Перенесённый рабочий выходной. По строке на дату в формате ГГГГ-ММ-ДД.',
};

export const ALL_SHEETS: readonly SheetDef[] = [PEOPLE, PROFILES, REQUESTS, HISTORY, SETTINGS];

export function columnLetter(index: number): string {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export const q = (sheet: string) => `'${sheet.replace(/'/g, "''")}'`;

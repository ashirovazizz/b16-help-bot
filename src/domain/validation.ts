import { FIELDS, type FieldKey, PHOTO_RULES, type ProfileFields } from './fields.js';
import type { Person, Profile, Request, RequestType } from './model.js';

/** Чистит текст из формы: переводы строк, хвостовые пробелы, лишние пустые строки. */
export function normalizeText(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/\r\n?/g, '\n')
    .replace(/[​-‍﻿]/g, '')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export type FormErrorKey = FieldKey | 'photo' | 'form';

export interface SubmissionInput {
  fields: Partial<Record<FieldKey, unknown>>;
  hasNewPhoto: boolean;
  comment?: string;
}

export interface SubmissionCheck {
  /** Что сохранить в заявку: для создания — все заполненные поля, для обновления — изменённые */
  fields: ProfileFields;
  changedKeys: FieldKey[];
  errors: Partial<Record<FormErrorKey, string>>;
}

/**
 * Проверяет анкету. Для обновления считает разницу с текущей страницей:
 * в заявку попадают только изменённые поля, пустое значение означает «убрать блок».
 */
export function checkSubmission(
  type: RequestType,
  input: SubmissionInput,
  current: Profile | undefined,
  opts: { allowCommentOnly?: boolean } = {},
): SubmissionCheck {
  const errors: SubmissionCheck['errors'] = {};
  const fields: ProfileFields = {};
  const changedKeys: FieldKey[] = [];

  for (const def of FIELDS) {
    const value = normalizeText(input.fields[def.key]);
    if (value.length > def.maxLength) {
      errors[def.key] = `Слишком длинно: ${value.length} из ${def.maxLength} знаков.`;
    }
    if (type === 'create') {
      if (def.requiredForCreate && !value) errors[def.key] = 'Обязательное поле.';
      if (value) {
        fields[def.key] = value;
        changedKeys.push(def.key);
      }
    } else if (value !== normalizeText(current?.fields[def.key])) {
      fields[def.key] = value;
      changedKeys.push(def.key);
    }
  }

  if (type === 'create' && PHOTO_RULES.requiredForCreate && !input.hasNewPhoto && !current?.photo) {
    errors.photo = 'Нужна фотография.';
  }

  if (type === 'update' && changedKeys.length === 0 && !input.hasNewPhoto) {
    const comment = normalizeText(input.comment);
    if (!(opts.allowCommentOnly && comment)) {
      errors.form = 'Вы ничего не изменили. Поправьте текст или загрузите новое фото.';
    }
  }

  return { fields, changedKeys, errors };
}

export function hasErrors(check: SubmissionCheck): boolean {
  return Object.keys(check.errors).length > 0;
}

/** Значения для формы: предложенные в заявке, иначе текущие со страницы. */
export function formValues(r: Request, profile: Profile | undefined): Record<FieldKey, string> {
  const out = {} as Record<FieldKey, string>;
  for (const def of FIELDS) {
    const proposed = r.fields[def.key];
    out[def.key] = proposed !== undefined ? proposed : (profile?.fields[def.key] ?? '');
  }
  return out;
}

/** Новая версия строки Profiles после закрытия заявки. */
export function applyToProfile(
  profile: Profile | undefined,
  r: Request,
  person: Pick<Person, 'personId' | 'fullName'>,
  now: Date,
): Profile {
  const base: Profile = profile
    ? { ...profile, fields: { ...profile.fields } }
    : { personId: person.personId, fullName: person.fullName, publication: 'none', fields: {} };
  base.fullName = person.fullName;
  base.updatedAt = now;
  base.lastRequestId = r.requestId;
  if (r.type === 'archive') {
    base.publication = 'archived';
    return base;
  }
  for (const def of FIELDS) {
    const v = r.fields[def.key];
    if (v !== undefined) base.fields[def.key] = v;
  }
  if (r.photo) base.photo = r.photo;
  if (r.pageUrl) base.pageUrl = r.pageUrl;
  base.publication = 'published';
  return base;
}

/** Что изменилось на странице — для записи прошлой версии в History. */
export function profileDiff(before: Profile | undefined, after: Profile): Record<string, unknown> {
  const diff: Record<string, { было: string; стало: string }> = {};
  for (const def of FIELDS) {
    const a = before?.fields[def.key] ?? '';
    const b = after.fields[def.key] ?? '';
    if (a !== b) diff[def.label] = { было: a, стало: b };
  }
  if ((before?.photo ?? '') !== (after.photo ?? '')) {
    diff.Фото = { было: before?.photo ?? '', стало: after.photo ?? '' };
  }
  if ((before?.pageUrl ?? '') !== (after.pageUrl ?? '')) {
    diff['Адрес страницы'] = { было: before?.pageUrl ?? '', стало: after.pageUrl ?? '' };
  }
  if ((before?.publication ?? 'none') !== after.publication) {
    diff.Публикация = { было: before?.publication ?? 'none', стало: after.publication };
  }
  return diff;
}

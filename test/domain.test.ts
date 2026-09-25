import { describe, expect, it } from 'vitest';
import { WorkCalendar } from '../src/core/calendar.js';
import { UserError } from '../src/core/errors.js';
import { formatDateTime, parseDateTime } from '../src/core/time.js';
import { DEFAULT_SETTINGS, type Profile, type Request } from '../src/domain/model.js';
import {
  applyToProfile,
  checkSubmission,
  formValues,
  hasErrors,
  normalizeText,
  profileDiff,
} from '../src/domain/validation.js';
import { type Actor, applyTransition, checkTransition } from '../src/domain/workflow.js';

const TZ = 'Europe/Moscow';
const cal = new WorkCalendar(TZ);
const at = (s: string) => parseDateTime(s, TZ)!;

const vika: Actor = { kind: 'editor', id: 111, name: 'Вика' };
const other: Actor = { kind: 'editor', id: 222, name: 'Маша' };
const requester: Actor = { kind: 'requester', id: 333, name: 'Азиз' };

function req(patch: Partial<Request> = {}): Request {
  return {
    requestId: 'R-0001',
    type: 'update',
    personId: 'P001',
    fullName: 'Азиз Аширов',
    status: 'draft',
    initiator: 'person',
    createdAt: at('2026-09-28 10:00'),
    statusSince: at('2026-09-28 10:00'),
    updatedAt: at('2026-09-28 10:00'),
    fields: {},
    ...patch,
  };
}

const profile: Profile = {
  personId: 'P001',
  fullName: 'Азиз Аширов',
  pageUrl: 'https://dh.itmo.ru/ashirov',
  publication: 'published',
  fields: { title: 'координатор', about: 'Старый текст', channel: 'https://t.me/x' },
  photo: 'https://drive.google.com/file/d/old/view',
};

describe('workflow', () => {
  it('ведёт обновление по основному пути и ставит сроки', () => {
    const now = at('2026-09-28 12:00');
    let r = applyTransition(req(), 'submit', requester, now, cal, DEFAULT_SETTINGS);
    expect(r.status).toBe('with_editor');
    expect(formatDateTime(r.dueAt!, TZ)).toBe('2026-10-01 23:59');
    expect(r.submittedAt).toEqual(now);

    r = applyTransition(r, 'take', vika, now, cal, DEFAULT_SETTINGS);
    expect(r.assigneeId).toBe(111);
    expect(r.status).toBe('with_editor');

    r = applyTransition(r, 'publish', vika, at('2026-09-29 12:00'), cal, DEFAULT_SETTINGS);
    expect(r.status).toBe('review');
    expect(formatDateTime(r.dueAt!, TZ)).toBe('2026-10-01 23:59');

    r = applyTransition(r, 'confirm', requester, at('2026-09-30 09:00'), cal, DEFAULT_SETTINGS);
    expect(r.status).toBe('done');
    expect(r.closedAt).toEqual(at('2026-09-30 09:00'));
    expect(r.dueAt).toBeUndefined();
  });

  it('снятие закрывается сразу после отметки редактора', () => {
    const r = req({ type: 'archive', initiator: 'registry', status: 'with_editor' });
    expect(checkTransition(r, 'publish', vika).status).toBe('done');
  });

  it('не даёт другому редактору перехватить взятую заявку', () => {
    const r = req({ status: 'with_editor', assigneeId: 111, assigneeName: 'Вика' });
    expect(() => checkTransition(r, 'publish', other)).toThrow(UserError);
    expect(() => checkTransition(r, 'take', other)).toThrow('ведёт Вика');
    expect(checkTransition(r, 'publish', vika).status).toBe('review');
  });

  it('закрепляет заявку за тем, кто первым нажал любую кнопку редактора', () => {
    const r = req({ status: 'with_editor' });
    expect(checkTransition(r, 'needInfo', other).assign).toEqual({ id: 222, name: 'Маша' });
  });

  it('правка после публикации возвращает заявку тому же редактору', () => {
    const r = req({ status: 'review', assigneeId: 111, assigneeName: 'Вика' });
    const fix = applyTransition(
      r,
      'askFix',
      requester,
      at('2026-09-29 10:00'),
      cal,
      DEFAULT_SETTINGS,
    );
    expect(fix.status).toBe('needs_info');
    const again = applyTransition(
      fix,
      'submit',
      requester,
      at('2026-09-29 11:00'),
      cal,
      DEFAULT_SETTINGS,
    );
    expect(again.status).toBe('with_editor');
    expect(again.assigneeId).toBe(111);
  });

  it('запрещает действия не в том статусе и чужими ролями', () => {
    expect(() => checkTransition(req({ status: 'review' }), 'publish', vika)).toThrow(UserError);
    expect(() => checkTransition(req({ status: 'done' }), 'cancel', requester)).toThrow(
      'уже закрыта',
    );
    expect(() => checkTransition(req(), 'confirm', vika)).toThrow();
    // снятие по решению реестра заявитель не подтверждает и не отменяет
    const archive = req({ type: 'archive', initiator: 'registry', status: 'with_editor' });
    expect(() => checkTransition(archive, 'cancel', requester)).toThrow(UserError);
  });

  it('черновик обновления живёт календарные дни, черновик новой страницы — с напоминанием', () => {
    const now = at('2026-09-28 10:00');
    const sent = applyTransition(
      req({ status: 'with_editor' }),
      'needInfo',
      vika,
      now,
      cal,
      DEFAULT_SETTINGS,
    );
    expect(formatDateTime(sent.dueAt!, TZ)).toBe('2026-09-30 23:59');
  });
});

describe('validation', () => {
  it('чистит текст', () => {
    expect(normalizeText('  a  \r\nb\n\n\n\nc​ ')).toBe('a\nb\n\nc');
    expect(normalizeText(undefined)).toBe('');
  });

  it('для обновления берёт только изменённые поля', () => {
    const check = checkSubmission(
      'update',
      {
        fields: { title: 'координатор', about: 'Новый текст', channel: '' },
        hasNewPhoto: false,
      },
      profile,
    );
    expect(hasErrors(check)).toBe(false);
    expect(check.changedKeys).toEqual(['about', 'channel']);
    expect(check.fields).toEqual({ about: 'Новый текст', channel: '' });
  });

  it('поле, которого нет во вводе, не считается стёртым', () => {
    const check = checkSubmission(
      'update',
      { fields: { about: 'Новый текст' }, hasNewPhoto: false },
      profile,
    );
    expect(check.fields).toEqual({ about: 'Новый текст' });
  });

  it('не пропускает обновление без изменений, но пропускает ответ комментарием', () => {
    const same = { fields: { ...profile.fields }, hasNewPhoto: false, comment: 'уточнила' };
    expect(checkSubmission('update', same, profile).errors.form).toBeDefined();
    expect(hasErrors(checkSubmission('update', same, profile, { allowCommentOnly: true }))).toBe(
      false,
    );
    expect(hasErrors(checkSubmission('update', { ...same, hasNewPhoto: true }, profile))).toBe(
      false,
    );
  });

  it('для новой страницы требует подпись, текст и фото', () => {
    const check = checkSubmission(
      'create',
      { fields: { about: 'текст' }, hasNewPhoto: false },
      undefined,
    );
    expect(check.errors.title).toBe('Обязательное поле.');
    expect(check.errors.photo).toBe('Нужна фотография.');
    expect(check.errors.about).toBeUndefined();
  });

  it('ограничивает длину', () => {
    const check = checkSubmission(
      'update',
      { fields: { ...profile.fields, title: 'а'.repeat(201) }, hasNewPhoto: false },
      profile,
    );
    expect(check.errors.title).toContain('201 из 200');
  });

  it('подставляет в форму предложенное, иначе текущее', () => {
    const values = formValues(req({ fields: { about: 'Черновик' } }), profile);
    expect(values.about).toBe('Черновик');
    expect(values.title).toBe('координатор');
    expect(values.courses).toBe('');
  });

  it('обновляет Profiles и сохраняет прошлую версию', () => {
    const r = req({ status: 'done', fields: { about: 'Новый текст', channel: '' }, photo: 'new' });
    const now = at('2026-09-30 10:00');
    const next = applyToProfile(profile, r, profile, now);
    expect(next.fields).toEqual({ title: 'координатор', about: 'Новый текст', channel: '' });
    expect(next.photo).toBe('new');
    expect(next.lastRequestId).toBe('R-0001');
    const diff = profileDiff(profile, next);
    expect(Object.keys(diff)).toEqual(['О себе', 'Канал', 'Фото']);
    expect(diff['О себе']).toEqual({ было: 'Старый текст', стало: 'Новый текст' });
  });

  it('снятие переводит страницу в архив, не стирая текст', () => {
    const r = req({ type: 'archive', status: 'done' });
    const next = applyToProfile(profile, r, profile, at('2026-09-30 10:00'));
    expect(next.publication).toBe('archived');
    expect(next.fields.about).toBe('Старый текст');
  });
});

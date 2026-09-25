import { describe, expect, it } from 'vitest';
import { silentLogger } from '../src/core/logger.js';
import { formatDateTime } from '../src/core/time.js';
import { LinkSigner } from '../src/core/tokens.js';
import type { Request } from '../src/domain/model.js';
import { MemoryPhotoStore } from '../src/photos/memory.js';
import { Links } from '../src/services/links.js';
import { RequestService } from '../src/services/service.js';
import { parseTime, SheetsRepository } from '../src/storage/sheets/repository.js';
import { SETTING_KEYS } from '../src/storage/sheets/schema.js';
import { FakeSheets } from './fake-sheets.js';
import { at, FakeNotifier, FakeSite, fakePng, TestClock, TZ } from './helpers.js';

const INVITE = 'https://t.me/dh_bot?start=';

function repoWith(extra: ConstructorParameters<typeof FakeSheets>[0] = {}) {
  const sheets = FakeSheets.workbook(extra);
  const repo = new SheetsRepository(sheets, { tz: TZ, inviteLinkBase: INVITE });
  return { sheets, repo };
}

const request = (patch: Partial<Request> = {}): Request => ({
  requestId: 'R-0001',
  type: 'update',
  personId: 'P001',
  fullName: 'Азиз Аширов',
  status: 'with_editor',
  initiator: 'person',
  createdAt: at('2026-09-28 10:00'),
  statusSince: at('2026-09-28 10:05'),
  updatedAt: at('2026-09-28 10:05'),
  submittedAt: at('2026-09-28 10:05'),
  dueAt: at('2026-10-01 23:59'),
  assigneeId: 900,
  assigneeName: 'Вика',
  fields: { about: 'Новый текст', channel: '' },
  photo: 'https://drive.google.com/file/d/abc/view',
  requesterNote: 'комментарий',
  cardMessageId: 5001,
  ...patch,
});

describe('SheetsRepository: People', () => {
  it('читает реестр, который заполняют люди, и пишет только свои колонки', async () => {
    const { sheets, repo } = repoWith({
      People: [
        ['', 'Азиз Аширов', 'сотрудники', 'координатор', 'работает', 'да', ''],
        ['P002', 'Пётр Петров', 'преподаватели', 'преподаватель', 'ушёл', 'нет', 'уточнить'],
        [],
      ],
    });
    const people = await repo.listPeople();
    expect(people).toHaveLength(2);
    expect(people[0]).toMatchObject({ ref: 2, personId: '', status: 'active', publish: true });
    expect(people[1]).toMatchObject({
      personId: 'P002',
      status: 'left',
      publish: false,
      note: 'уточнить',
    });

    await repo.assignPersonId(2, 'Азиз Аширов', 'P001');
    await expect(repo.assignPersonId(2, 'Кто-то другой', 'P009')).rejects.toThrow('изменилась');

    await repo.patchPerson('P001', {
      telegramUserId: 501,
      telegramUsername: 'aziz_test',
      boundAt: at('2026-09-28 10:00'),
      inviteCode: null,
    });
    const row = sheets.grid('People')[1]!;
    expect(row.slice(0, 11)).toEqual([
      'P001',
      'Азиз Аширов',
      'сотрудники',
      'координатор',
      'работает',
      'да',
      '',
      501,
      '@aziz_test',
      '2026-09-28 10:00',
      '',
    ]);
    const [aziz] = await repo.listPeople();
    expect(aziz).toMatchObject({ telegramUserId: 501, telegramUsername: 'aziz_test' });
  });

  it('хранит приглашение ссылкой и достаёт из неё код', async () => {
    const { sheets, repo } = repoWith({
      People: [['P001', 'Новый', 'преподаватели', '', 'работает', 'да']],
    });
    await repo.patchPerson('P001', {
      inviteCode: 'AbC_123-xyz',
      inviteExpiresAt: at('2026-10-28 10:00'),
    });
    expect(sheets.grid('People')[1]![10]).toBe(`${INVITE}AbC_123-xyz`);
    const [p] = await repo.listPeople();
    expect(p?.inviteCode).toBe('AbC_123-xyz');
    expect(formatDateTime(p!.inviteExpiresAt!, TZ)).toBe('2026-10-28 10:00');
  });

  it('понимает разные написания статуса и публикации', async () => {
    const { repo } = repoWith({
      People: [
        ['P001', 'А', '', '', 'ушла', 'Да'],
        ['P002', 'Б', '', '', '', true],
        ['P003', 'В', '', '', 'работает', 'нет'],
      ],
    });
    const [a, b, c] = await repo.listPeople();
    expect(a).toMatchObject({ status: 'left', publish: true });
    expect(b).toMatchObject({ status: 'active', publish: true });
    expect(c).toMatchObject({ status: 'active', publish: false });
  });

  it('ругается понятно, если в листе нет нужной колонки', async () => {
    const sheets = new FakeSheets({ People: [['ФИО', 'Статус']] });
    const repo = new SheetsRepository(sheets, { tz: TZ, inviteLinkBase: INVITE });
    await expect(repo.listPeople()).rejects.toThrow('нет колонок: ID, Публикуем на сайте');
  });
});

describe('SheetsRepository: Requests, Profiles, History', () => {
  it('сохраняет заявку и читает её обратно без потерь', async () => {
    const { sheets, repo } = repoWith();
    const r = request();
    await repo.insertRequest(r);
    const row = sheets.grid('Requests')[1]!;
    expect(row.slice(0, 6)).toEqual([
      'R-0001',
      'Обновление',
      'P001',
      'Азиз Аширов',
      'У редактора',
      'редактор',
    ]);
    expect(row).toContain('О себе, Канал');
    expect(await repo.getRequest('R-0001')).toEqual(r);
    expect(await repo.nextRequestId()).toBe('R-0002');
    await expect(repo.insertRequest(r)).rejects.toThrow('уже есть');
  });

  it('обновляет строку заявки на месте и не трогает чужие колонки', async () => {
    const { sheets, repo } = repoWith();
    const g = sheets.grid('Requests');
    g[0]!.push('Заметки стажёра');
    await repo.insertRequest(request());
    await repo.insertRequest(request({ requestId: 'R-0002', personId: 'P002' }));
    const width = g[0]!.length;
    g[1]![width - 1] = 'позвонить Азизу';

    const closed = request({
      status: 'done',
      closedAt: at('2026-09-30 10:00'),
      closeReason: 'подтверждено заявителем',
    });
    delete closed.dueAt;
    await repo.updateRequest(closed);
    expect(g[1]![width - 1]).toBe('позвонить Азизу');
    expect(g[1]![5]).toBe('—');
    expect(await repo.getRequest('R-0001')).toEqual(closed);
    expect((await repo.getRequest('R-0002'))?.status).toBe('with_editor');
  });

  it('добавляет и обновляет строку Profiles', async () => {
    const { sheets, repo } = repoWith();
    const profile = {
      personId: 'P001',
      fullName: 'Азиз Аширов',
      pageUrl: 'https://dh.itmo.ru/ashirov',
      publication: 'published' as const,
      fields: { title: 'координатор', about: 'Текст' },
      photo: 'https://drive.google.com/file/d/abc/view',
      updatedAt: at('2026-09-30 10:00'),
      lastRequestId: 'R-0001',
    };
    await repo.saveProfile(profile);
    await repo.saveProfile({ ...profile, publication: 'archived' });
    expect(sheets.grid('Profiles')).toHaveLength(2);
    expect(await repo.listProfiles()).toEqual([{ ...profile, publication: 'archived' }]);
  });

  it('дописывает историю', async () => {
    const { sheets, repo } = repoWith();
    await repo.appendHistory([
      {
        at: at('2026-09-30 10:00'),
        requestId: 'R-0001',
        personId: 'P001',
        event: 'взята в работу',
        from: 'У редактора',
        to: 'У редактора',
        actor: 'Вика',
      },
      { at: at('2026-09-30 10:01'), event: 'реестр: присвоен ID', actor: 'бот' },
    ]);
    const g = sheets.grid('History');
    expect(g).toHaveLength(3);
    expect(g[1]).toEqual([
      '2026-09-30 10:00',
      'R-0001',
      'P001',
      'взята в работу',
      'У редактора',
      'У редактора',
      'Вика',
      '',
    ]);
  });
});

describe('SheetsRepository: Settings', () => {
  it('читает настройки, праздники и время в разных видах', async () => {
    const { repo } = repoWith({
      Settings: [
        [SETTING_KEYS.reminderDays, '4', ''],
        [SETTING_KEYS.inviteDays, 'много', ''],
        [SETTING_KEYS.holiday, '2026-11-04', ''],
        [SETTING_KEYS.holiday, 46387, ''],
        [SETTING_KEYS.workday, '31.10.2026', ''],
      ],
    });
    const s = await repo.loadSettings();
    expect(s).toMatchObject({
      editorDays: 3,
      reviewDays: 2,
      reminderDays: 4,
      inviteDays: 30,
      digestTime: '10:00',
    });
    expect(s.holidays).toEqual(['2026-11-04', '2026-12-31']);
    expect(s.workdays).toEqual(['2026-10-31']);
  });

  it('понимает время, которое Таблица превратила в число', () => {
    expect(parseTime(10 / 24)).toBe('10:00');
    expect(parseTime('9:30:00')).toBe('09:30');
    expect(parseTime('25:00')).toBeUndefined();
  });
});

describe('сервис поверх Google Таблицы', () => {
  it('проходит обновление страницы целиком', async () => {
    const { sheets, repo } = repoWith({
      People: [['P001', 'Азиз Аширов', 'сотрудники', 'координатор', 'работает', 'да', '', 501]],
      Profiles: [
        [
          'P001',
          'Азиз Аширов',
          'https://dh.itmo.ru/ashirov',
          'опубликована',
          'координатор',
          'Старый текст',
        ],
      ],
    });
    const clock = new TestClock(at('2026-09-28 10:00'));
    const service = new RequestService({
      repo,
      notifier: new FakeNotifier(),
      photos: new MemoryPhotoStore(),
      links: new Links(new LinkSigner('s'.repeat(40)), 'https://forms.example.org', clock),
      clock,
      tz: TZ,
      log: silentLogger,
      site: new FakeSite(),
      settingsTtlMs: 0,
    });
    const start = await service.startUpdate(501);
    const id = start.request.requestId;
    const res = await service.submitForm(id, {
      fields: { about: 'Новый текст' },
      photo: fakePng(),
    });
    expect(res.ok).toBe(true);
    await service.publish(id, { kind: 'editor', id: 900, name: 'Вика' });
    await service.confirm(501, id);
    expect((await repo.getRequest(id))?.status).toBe('done');
    const [profile] = await repo.listProfiles();
    expect(profile?.fields.about).toBe('Новый текст');
    expect(sheets.grid('History').length).toBeGreaterThan(5);
  });
});

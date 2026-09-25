import { describe, expect, it } from 'vitest';
import { UserError } from '../src/core/errors.js';
import { formatDateTime } from '../src/core/time.js';
import { fakePng, otherEditor, people, profiles, setup, TZ, vika } from './helpers.js';

describe('доступ к боту (раздел 15 ТЗ)', () => {
  it('неизвестный Telegram ID не может создать заявку', async () => {
    const { service, repo } = setup();
    await expect(service.startUpdate(12345)).rejects.toThrow(UserError);
    expect(repo.requests).toHaveLength(0);
  });

  it('ушедший сотрудник с привязанным Telegram не продолжит заявку', async () => {
    const { service, repo } = setup();
    const start = await service.startUpdate(501);
    expect(start.kind).toBe('form');
    repo.people.find((p) => p.personId === 'P001')!.status = 'left';
    await expect(service.startUpdate(501)).rejects.toThrow('Доступ закрыт');
    await expect(
      service.submitForm(start.request.requestId, { fields: { about: 'новое' } }),
    ).rejects.toThrow(UserError);
  });

  it('без страницы нельзя «обновить» — новую страницу запускает реестр', async () => {
    const { service, repo } = setup({
      people: [{ ...people.newbie, telegramUserId: 503 }],
      profiles: [],
    });
    await expect(service.startUpdate(503)).rejects.toThrow('пока нет');
    await expect(service.requestArchive(503)).rejects.toThrow('снимать нечего');
    expect(repo.requests).toHaveLength(0);
  });

  it('повторное «обновить» не плодит заявки, даже одновременно', async () => {
    const { service, repo } = setup();
    const [a, b] = await Promise.all([service.startUpdate(501), service.startUpdate(501)]);
    expect(a.request.requestId).toBe(b.request.requestId);
    expect(repo.requests).toHaveLength(1);
  });

  it('чужую заявку нельзя подтвердить или отменить', async () => {
    const { service } = setup();
    const { request } = await service.startUpdate(501);
    await expect(service.cancel(502, request.requestId)).rejects.toThrow('не ваша');
    await expect(service.confirm(502, request.requestId)).rejects.toThrow('не ваша');
  });
});

describe('обновление страницы', () => {
  it('проходит весь путь и обновляет Profiles', async () => {
    const { service, repo, notifier, clock } = setup();
    const start = await service.startUpdate(501);
    const id = start.request.requestId;
    expect(start.kind === 'form' && start.message.buttons?.[0]?.[0]).toMatchObject({
      text: 'Открыть форму',
    });
    expect(notifier.cardLog).toHaveLength(0); // черновик редактору не показываем

    const sent = await service.submitForm(id, {
      fields: { title: 'координатор', about: 'Новый текст' },
      photo: fakePng(),
      comment: 'обновил фото',
    });
    expect(sent.ok).toBe(true);
    let r = await repo.getRequest(id);
    expect(r?.status).toBe('with_editor');
    expect(r?.fields).toEqual({ about: 'Новый текст' });
    expect(r?.photo).toMatch(/^memory:\/\/P001_R-0001/);
    expect(r?.cardMessageId).toBeDefined();
    expect(notifier.notes.some((n) => n.attachment?.mimeType === 'image/png')).toBe(true);

    await service.take(id, vika);
    clock.set('2026-09-29 11:00');
    const pub = await service.publish(id, vika);
    expect(pub.kind).toBe('done');
    r = await repo.getRequest(id);
    expect(r?.status).toBe('review');
    expect(r?.pageUrl).toBe('https://dh.itmo.ru/ashirov');
    expect(notifier.lastDm(501)?.text).toContain('обновлена');

    await service.confirm(501, id);
    r = await repo.getRequest(id);
    expect(r?.status).toBe('done');
    const profile = repo.profiles.find((p) => p.personId === 'P001')!;
    expect(profile.fields.about).toBe('Новый текст');
    expect(profile.photo).toBe(r?.photo);
    expect(profile.lastRequestId).toBe(id);

    // История: все переходы и прошлая версия страницы
    const events = repo.history.filter((h) => h.requestId === id).map((h) => h.event);
    expect(events).toEqual([
      'создана: обновление',
      'отправлена редактору',
      'взята в работу',
      'отмечена как опубликованная',
      'подтверждена заявителем',
      'страница обновлена',
    ]);
    const diff = JSON.parse(repo.history.at(-1)!.details!);
    expect(diff['О себе']).toEqual({ было: 'Старый текст', стало: 'Новый текст' });
  });

  it('отклоняет пустую и слишком длинную анкету и маленькое фото', async () => {
    const { service, repo } = setup();
    const { request } = await service.startUpdate(501);
    const same = await service.submitForm(request.requestId, {
      fields: { ...profiles.aziz!.fields },
    });
    expect(same.ok).toBe(false);
    const tiny = await service.submitForm(request.requestId, {
      fields: { ...profiles.aziz!.fields },
      photo: fakePng(300, 300),
    });
    expect(!tiny.ok && tiny.errors.photo).toContain('слишком маленькое');
    const long = await service.submitForm(request.requestId, {
      fields: { ...profiles.aziz!.fields, title: 'а'.repeat(500) },
    });
    expect(!long.ok && long.errors.title).toContain('500 из 200');
    expect(!long.ok && long.model.values.title).toBe('а'.repeat(500));
    expect((await repo.getRequest(request.requestId))?.status).toBe('draft');
  });

  it('повторная отправка той же формы не проходит', async () => {
    const { service } = setup();
    const { request } = await service.startUpdate(501);
    await service.submitForm(request.requestId, { fields: { about: 'Новый текст' } });
    await expect(
      service.submitForm(request.requestId, { fields: { about: 'Ещё раз' } }),
    ).rejects.toThrow('у редактора');
  });

  it('другой редактор не может взять или опубликовать чужую заявку', async () => {
    const { service } = setup();
    const { request } = await service.startUpdate(501);
    await service.submitForm(request.requestId, { fields: { about: 'Новый текст' } });
    await service.take(request.requestId, vika);
    await expect(service.take(request.requestId, otherEditor)).rejects.toThrow('ведёт Вика');
    await expect(service.publish(request.requestId, otherEditor)).rejects.toThrow('ведёт Вика');
    // повторное «Беру» от того же редактора — не ошибка
    await expect(service.take(request.requestId, vika)).resolves.toBeDefined();
  });

  it('вопрос редактора и ответ заявителя: заявка возвращается тому же редактору', async () => {
    const { service, repo, notifier } = setup();
    const { request } = await service.startUpdate(501);
    const id = request.requestId;
    await service.submitForm(id, { fields: { about: 'Новый текст' } });
    await service.needInfo(id, vika, 'Пришлите фото получше');
    expect((await repo.getRequest(id))?.status).toBe('needs_info');
    expect(notifier.lastDm(501)?.text).toContain('Пришлите фото получше');

    const model = await service.openForm(id, 'requester');
    expect(model.editable).toBe(true);
    expect(model.notice).toContain('Пришлите фото получше');
    expect(model.values.about).toBe('Новый текст');

    await service.submitForm(id, {
      fields: { about: 'Новый текст' },
      comment: 'вот',
      photo: fakePng(),
    });
    const r = await repo.getRequest(id);
    expect(r?.status).toBe('with_editor');
    expect(r?.assigneeId).toBe(vika.id);
    expect(notifier.notes.some((n) => n.text.includes('дополнил'))).toBe(true);
  });

  it('правка после публикации: заявитель исправляет анкету, редактор публикует снова', async () => {
    const { service, repo } = setup();
    const { request } = await service.startUpdate(501);
    const id = request.requestId;
    await service.submitForm(id, { fields: { about: 'Текст с опечаткой' } });
    await service.publish(id, vika);
    const fix = await service.askFix(501, id);
    expect(fix.request.status).toBe('needs_info');
    await service.submitForm(id, { fields: { about: 'Текст без опечатки' } });
    let r = await repo.getRequest(id);
    expect(r?.status).toBe('with_editor');
    expect(r?.assigneeId).toBe(vika.id);
    await service.publish(id, vika);
    await service.confirm(501, id);
    r = await repo.getRequest(id);
    expect(r?.status).toBe('done');
    expect(repo.profiles.find((p) => p.personId === 'P001')?.fields.about).toBe(
      'Текст без опечатки',
    );
  });

  it('редактор правит текст в форме, и в Profiles попадает его версия', async () => {
    const { service, repo } = setup();
    const { request } = await service.startUpdate(501);
    const id = request.requestId;
    await service.submitForm(id, { fields: { about: 'Текст , с лишним пробелом' } });
    const model = await service.openForm(id, 'editor');
    expect(model.editable).toBe(true);
    const res = await service.saveEditorForm(id, {
      fields: { ...model.values, about: 'Текст, без лишнего пробела' },
    });
    expect(res.ok).toBe(true);
    await service.publish(id, vika);
    await service.confirm(501, id);
    expect(repo.profiles.find((p) => p.personId === 'P001')?.fields.about).toBe(
      'Текст, без лишнего пробела',
    );
    expect(repo.history.some((h) => h.event === 'правка редактора')).toBe(true);
  });

  it('молчание заявителя: автоподтверждение через 2 рабочих дня', async () => {
    const { service, repo, clock, notifier } = setup();
    const { request } = await service.startUpdate(501);
    const id = request.requestId;
    await service.submitForm(id, { fields: { about: 'Новый текст' } });
    clock.set('2026-09-28 15:00'); // понедельник
    await service.publish(id, vika);
    const r = await repo.getRequest(id);
    expect(formatDateTime(r!.dueAt!, TZ)).toBe('2026-09-30 23:59');

    clock.set('2026-09-30 20:00');
    await service.tick();
    expect((await repo.getRequest(id))?.status).toBe('review');

    clock.set('2026-10-01 00:05');
    await service.tick();
    const done = await repo.getRequest(id);
    expect(done?.status).toBe('done');
    expect(done?.closeReason).toBe('подтверждено автоматически');
    expect(repo.profiles.find((p) => p.personId === 'P001')?.fields.about).toBe('Новый текст');
    expect(notifier.lastDm(501)?.text).toContain('закрыта');
  });

  it('неотправленный черновик обновления истекает через 14 дней', async () => {
    const { service, repo, clock } = setup();
    const { request } = await service.startUpdate(501); // 28.09 10:00
    clock.set('2026-10-12 09:59');
    await service.tick();
    expect((await repo.getRequest(request.requestId))?.status).toBe('draft');
    clock.set('2026-10-12 10:01');
    await service.tick();
    const r = await repo.getRequest(request.requestId);
    expect(r?.status).toBe('cancelled');
    expect(r?.closeReason).toBe('черновик не отправлен');
  });

  it('отказ редактора сообщается заявителю', async () => {
    const { service, repo, notifier } = setup();
    const { request } = await service.startUpdate(501);
    await service.submitForm(request.requestId, { fields: { about: 'Новый текст' } });
    await service.reject(request.requestId, vika, 'Текст не про работу в центре');
    expect((await repo.getRequest(request.requestId))?.status).toBe('rejected');
    expect(notifier.lastDm(501)?.text).toContain('Текст не про работу в центре');
  });

  it('сбой Telegram не ломает заявку, а поднимает тревогу', async () => {
    const { service, repo, notifier } = setup();
    notifier.failCards = true;
    const { request } = await service.startUpdate(501);
    const res = await service.submitForm(request.requestId, { fields: { about: 'Новый текст' } });
    expect(res.ok).toBe(true);
    expect((await repo.getRequest(request.requestId))?.status).toBe('with_editor');
    expect(notifier.alerts[0]).toContain('карточку');
  });
});

describe('сверка с реестром', () => {
  it('новый человек в реестре: ID, заявка на страницу, приглашение, анкета после привязки', async () => {
    const { service, repo, notifier } = setup({
      people: [{ ...people.newbie, personId: '' }],
      profiles: [],
    });
    const report = await service.syncRegistry();
    expect(report.assignedIds).toEqual(['P001']);
    expect(report.created).toHaveLength(1);
    expect(report.invites).toEqual(['P001']);
    const person = repo.people[0]!;
    expect(person.inviteCode).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const draft = repo.requests[0]!;
    expect(draft).toMatchObject({ type: 'create', status: 'draft', initiator: 'registry' });

    // повторная сверка ничего не дублирует
    const again = await service.syncRegistry();
    expect(again.created).toHaveLength(0);
    expect(again.invites).toHaveLength(0);

    const bound = await service.bind(person.inviteCode!, { id: 777, name: 'Новый' });
    expect(bound.pending?.request.requestId).toBe(draft.requestId);
    expect(repo.people[0]?.telegramUserId).toBe(777);
    expect(repo.people[0]?.inviteCode).toBeUndefined();

    // ссылка одноразовая
    await expect(service.bind(person.inviteCode!, { id: 778, name: 'Чужой' })).rejects.toThrow(
      'недействительна',
    );

    // анкета: без фото и текста не пройдёт
    const bad = await service.submitForm(draft.requestId, { fields: { title: 'преподаватель' } });
    expect(!bad.ok && bad.errors.about).toBeDefined();
    expect(!bad.ok && bad.errors.photo).toBeDefined();
    await service.submitForm(draft.requestId, {
      fields: { title: 'преподаватель', about: 'Преподаю философию' },
      photo: fakePng(),
    });

    // для новой страницы редактор присылает адрес
    const pub = await service.publish(draft.requestId, vika);
    expect(pub.kind).toBe('needUrl');
    await expect(service.publish(draft.requestId, vika, 'https://evil.example/x')).rejects.toThrow(
      'страницу сайта',
    );
    await service.publish(draft.requestId, vika, 'https://dh.itmo.ru/newbie');
    await service.confirm(777, draft.requestId);
    expect(repo.profiles[0]).toMatchObject({
      personId: 'P001',
      publication: 'published',
      pageUrl: 'https://dh.itmo.ru/newbie',
    });
    expect(notifier.dms.some((d) => d.userId === 777)).toBe(true);

    // страница есть — сверка больше ничего не создаёт
    expect((await service.syncRegistry()).created).toHaveLength(0);
  });

  it('ушедший сотрудник: заявка на снятие, открытое обновление отзывается', async () => {
    const { service, repo } = setup();
    const { request } = await service.startUpdate(501);
    repo.people.find((p) => p.personId === 'P001')!.status = 'left';
    const report = await service.syncRegistry();
    expect(report.withdrawn).toEqual([request.requestId]);
    expect(report.archived).toHaveLength(1);
    const archive = repo.requests.find((r) => r.type === 'archive')!;
    expect(archive).toMatchObject({ status: 'with_editor', initiator: 'registry' });
    expect(archive.cardMessageId).toBeDefined();

    // снятие закрывается сразу по кнопке, URL не нужен; сайт отвечает 404
    const site = (service as unknown as { d: { site: { statuses: Map<string, number> } } }).d.site;
    site.statuses.set('https://dh.itmo.ru/ashirov', 404);
    const res = await service.publish(archive.requestId, vika);
    expect(res.kind === 'done' && res.warning).toBeUndefined();
    expect((await repo.getRequest(archive.requestId))?.status).toBe('done');
    expect(repo.profiles.find((p) => p.personId === 'P001')?.publication).toBe('archived');
    // текст страницы не стирается
    expect(repo.profiles.find((p) => p.personId === 'P001')?.fields.about).toBe('Старый текст');
  });

  it('предупреждает, если снятая страница всё ещё открывается', async () => {
    const { service, repo, notifier } = setup();
    repo.people.find((p) => p.personId === 'P002')!.publish = false;
    await service.syncRegistry();
    const archive = repo.requests.find((r) => r.type === 'archive')!;
    const res = await service.publish(archive.requestId, vika);
    expect(res.kind === 'done' && res.warning).toContain('всё ещё открывается');
    expect(notifier.notes.some((n) => n.text.includes('всё ещё открывается'))).toBe(true);
  });

  it('реестр передумал: лишние заявки отзываются', async () => {
    const { service, repo } = setup({
      people: [people.aziz, people.newbie],
      profiles: [profiles.aziz!],
    });
    await service.syncRegistry();
    const create = repo.requests.find((r) => r.type === 'create')!;
    repo.people.find((p) => p.personId === 'P003')!.status = 'left';
    repo.people.find((p) => p.personId === 'P001')!.publish = false;
    await service.syncRegistry();
    const archive = repo.requests.find((r) => r.type === 'archive')!;
    expect((await repo.getRequest(create.requestId))?.status).toBe('cancelled');
    repo.people.find((p) => p.personId === 'P001')!.publish = true;
    const report = await service.syncRegistry();
    expect(report.withdrawn).toContain(archive.requestId);
    expect((await repo.getRequest(archive.requestId))?.status).toBe('cancelled');
  });

  it('человек сам снял страницу — реестр отмечает отказ, сверка её не возвращает', async () => {
    const { service, repo } = setup();
    const archive = await service.requestArchive(501);
    expect(archive).toMatchObject({ type: 'archive', initiator: 'person', status: 'with_editor' });
    await service.publish(archive.requestId, vika);
    const person = repo.people.find((p) => p.personId === 'P001')!;
    expect(person.publish).toBe(false);
    expect(person.note).toContain('сам снял страницу');
    await service.syncRegistry();
    expect(repo.requests.filter((r) => r.personId === 'P001' && r.type === 'create')).toHaveLength(
      0,
    );
  });

  it('человек отказался от новой страницы — реестр это запоминает', async () => {
    const { service, repo } = setup({
      people: [{ ...people.newbie, telegramUserId: 503 }],
      profiles: [],
    });
    await service.syncRegistry();
    const draft = repo.requests[0]!;
    await service.cancel(503, draft.requestId);
    expect(repo.people[0]?.publish).toBe(false);
    expect((await service.syncRegistry()).created).toHaveLength(0);
  });

  it('сообщает о дублях ID в реестре', async () => {
    const { service } = setup({
      people: [people.aziz, { ...people.masha, personId: 'P001' }],
    });
    const report = await service.syncRegistry();
    expect(report.problems[0]).toContain('P001');
  });

  it('Telegram нельзя привязать ко второму человеку', async () => {
    const { service, repo } = setup({
      people: [people.aziz, people.newbie],
      profiles: [profiles.aziz!],
    });
    await service.syncRegistry();
    const code = repo.people.find((p) => p.personId === 'P003')!.inviteCode!;
    await expect(service.bind(code, { id: 501, name: 'Азиз' })).rejects.toThrow('уже привязан');
  });
});

describe('сводка и напоминания', () => {
  it('собирает сводку по рабочим дням и напоминает заявителям', async () => {
    const { service, repo, notifier, clock } = setup();
    // заявка у редактора и черновик новой страницы
    const { request } = await service.startUpdate(501);
    await service.submitForm(request.requestId, { fields: { about: 'Новый текст' } });
    await service.syncRegistry();
    const create = repo.requests.find((r) => r.type === 'create')!;

    clock.set('2026-10-03 10:00'); // суббота
    expect((await service.daily()).digest).toBeUndefined();

    clock.set('2026-10-05 10:00'); // понедельник
    const { digest } = await service.daily();
    expect(digest).toContain('У редактора — 1');
    expect(digest).toContain('просрочено');
    expect(digest).toContain('никто не взял');
    expect(digest).toContain(`${create.requestId} Новый Преподаватель`);
    expect(digest).toContain('не подключился к боту');
    expect(notifier.ops).toHaveLength(1);
  });

  it('напоминает о запрошенных данных не чаще, чем раз в срок', async () => {
    const { service, notifier, clock } = setup();
    const { request } = await service.startUpdate(501);
    await service.submitForm(request.requestId, { fields: { about: 'Новый текст' } });
    await service.needInfo(request.requestId, vika, 'Уточните курсы');
    const before = notifier.dms.length;
    clock.set('2026-10-01 10:00');
    expect((await service.daily()).reminders).toEqual([request.requestId]);
    expect(notifier.dms.length).toBe(before + 1);
    clock.set('2026-10-02 10:00');
    expect((await service.daily()).reminders).toEqual([]);
  });

  it('в последний день проверки напоминает об автоподтверждении', async () => {
    const { service, notifier, clock } = setup();
    const { request } = await service.startUpdate(501);
    await service.submitForm(request.requestId, { fields: { about: 'Новый текст' } });
    await service.publish(request.requestId, vika); // пн 28.09 → автоподтверждение после 30.09
    clock.set('2026-09-29 10:00');
    expect((await service.daily()).reminders).toEqual([request.requestId]);
    expect(notifier.lastDm(501)?.text).toContain('Напоминание');
    clock.set('2026-09-30 10:00');
    expect((await service.daily()).reminders).toEqual([]);
  });
});

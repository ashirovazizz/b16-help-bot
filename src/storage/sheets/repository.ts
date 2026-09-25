import { formatDateTime, parseDateKey, parseDateTime } from '../../core/time.js';
import { FIELD_BY_KEY, FIELDS, type FieldKey, type ProfileFields } from '../../domain/fields.js';
import {
  BALL_LABELS,
  ballOf,
  DEFAULT_SETTINGS,
  type HistoryEvent,
  INITIATOR_LABELS,
  type Initiator,
  type Profile,
  PUBLICATION_LABELS,
  REQUEST_TYPE_LABELS,
  type Request,
  type RequestStatus,
  type RequestType,
  type Settings,
  STATUS_LABELS,
} from '../../domain/model.js';
import {
  formatRequestId,
  type PersonPatch,
  type PersonRow,
  parseRequestNumber,
  type Repository,
  type Snapshot,
} from '../repository.js';
import type { Cell, SheetsGateway } from './gateway.js';
import {
  columnLetter,
  H,
  HISTORY,
  P,
  PEOPLE,
  PR,
  PROFILES,
  q,
  REQUESTS,
  RQ,
  S,
  SETTING_KEYS,
  SETTINGS,
} from './schema.js';

/* ───── разбор значений ───── */

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim());

function reverse<K extends string>(labels: Record<K, string>): Map<string, K> {
  return new Map(Object.entries(labels).map(([k, v]) => [String(v).toLowerCase(), k as K]));
}

const STATUS_BY_LABEL = reverse(STATUS_LABELS);
const TYPE_BY_LABEL = reverse(REQUEST_TYPE_LABELS);
const INITIATOR_BY_LABEL = reverse(INITIATOR_LABELS);
const PUBLICATION_BY_LABEL = reverse(PUBLICATION_LABELS);
const FIELD_BY_LABEL = new Map(FIELDS.map((f) => [f.label.toLowerCase(), f.key]));

function yes(v: unknown): boolean {
  if (v === true) return true;
  return /^(да|yes|true|1|истина|✓|\+)$/i.test(str(v));
}

function personStatus(v: unknown): PersonRow['status'] {
  return /^(ушёл|ушел|ушла|ушли|не работает|left)$/i.test(str(v)) ? 'left' : 'active';
}

function num(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : Number(str(v));
  return str(v) !== '' && Number.isFinite(n) ? n : undefined;
}

/** Колонки листа: заголовок → номер колонки (с нуля). */
type HeaderMap = Map<string, number>;

interface Table {
  header: HeaderMap;
  /** Строки данных; строка i лежит в строке листа i + 2 */
  rows: unknown[][];
}

function tableOf(values: unknown[][]): Table {
  const header: HeaderMap = new Map();
  (values[0] ?? []).forEach((h, i) => {
    const name = str(h);
    if (name && !header.has(name)) header.set(name, i);
  });
  return { header, rows: values.slice(1) };
}

const isEmptyRow = (row: unknown[]) => row.every((c) => str(c) === '');

export interface SheetsRepositoryOptions {
  tz: string;
  /** «https://t.me/имя_бота?start=» — из кода приглашения получается ссылка */
  inviteLinkBase: string;
}

/**
 * Хранилище в Google Таблице. Каждое чтение идёт в таблицу заново:
 * люди правят People и Settings руками, и бот должен видеть актуальное.
 */
export class SheetsRepository implements Repository {
  constructor(
    private readonly gw: SheetsGateway,
    private readonly opts: SheetsRepositoryOptions,
  ) {}

  /* ───── общие операции ───── */

  private async read(...sheets: string[]): Promise<Table[]> {
    const values = await this.gw.batchGet(sheets.map(q));
    return values.map((v, i) => {
      const t = tableOf(v);
      if (!t.header.size) throw new Error(`Лист ${sheets[i]} пустой: запустите настройку книги`);
      return t;
    });
  }

  private cell(t: Table, row: unknown[], header: string): unknown {
    const i = t.header.get(header);
    return i === undefined ? undefined : row[i];
  }

  private require(t: Table, sheet: string, headers: readonly string[]) {
    const missing = headers.filter((h) => !t.header.has(h));
    if (missing.length) {
      throw new Error(`На листе ${sheet} нет колонок: ${missing.join(', ')}`);
    }
  }

  /** Строка для записи: только свои колонки, чужие — null (не трогать). */
  private rowOf(t: Table, values: Record<string, Cell>): Cell[] {
    const width = Math.max(...t.header.values()) + 1;
    const row: Cell[] = new Array(width).fill(null);
    for (const [header, value] of Object.entries(values)) {
      const i = t.header.get(header);
      if (i !== undefined) row[i] = value;
    }
    return row;
  }

  private rowRange(sheet: string, t: Table, rowNumber: number): string {
    const last = columnLetter(Math.max(...t.header.values()));
    return `${q(sheet)}!A${rowNumber}:${last}${rowNumber}`;
  }

  /** Находит строку листа по ключу, перечитывая колонку прямо перед записью. */
  private async findRow(sheet: string, t: Table, keyHeader: string, key: string) {
    const col = t.header.get(keyHeader);
    if (col === undefined) throw new Error(`На листе ${sheet} нет колонки ${keyHeader}`);
    const letter = columnLetter(col);
    const [values = []] = await this.gw.batchGet([`${q(sheet)}!${letter}:${letter}`]);
    const found: number[] = [];
    values.forEach((row, i) => {
      if (i > 0 && str(row[0]) === key) found.push(i + 1);
    });
    if (found.length > 1)
      throw new Error(`На листе ${sheet} ${keyHeader} ${key} встречается дважды`);
    return found[0];
  }

  private date(v: unknown): Date | undefined {
    return parseDateTime(v, this.opts.tz);
  }

  private fmt(d: Date | undefined): string {
    return d ? formatDateTime(d, this.opts.tz) : '';
  }

  /* ───── People ───── */

  private inviteCodeOf(link: unknown): string | undefined {
    const s = str(link);
    if (!s) return undefined;
    const m = /[?&]start=([A-Za-z0-9_-]+)/.exec(s);
    return m?.[1];
  }

  private peopleFrom(t: Table): PersonRow[] {
    this.require(t, PEOPLE.name, [P.id, P.fullName, P.status, P.publish]);
    const out: PersonRow[] = [];
    t.rows.forEach((row, i) => {
      if (isEmptyRow(row)) return;
      const c = (h: string) => this.cell(t, row, h);
      const p: PersonRow = {
        ref: i + 2,
        personId: str(c(P.id)),
        fullName: str(c(P.fullName)),
        category: str(c(P.category)),
        orgRole: str(c(P.orgRole)),
        status: personStatus(c(P.status)),
        publish: yes(c(P.publish)),
        note: str(c(P.note)),
      };
      const tgId = num(c(P.telegramId));
      if (tgId !== undefined) p.telegramUserId = tgId;
      const username = str(c(P.telegram)).replace(/^@/, '');
      if (username) p.telegramUsername = username;
      const boundAt = this.date(c(P.boundAt));
      if (boundAt) p.boundAt = boundAt;
      const code = this.inviteCodeOf(c(P.invite));
      if (code) p.inviteCode = code;
      const until = this.date(c(P.inviteUntil));
      if (until) p.inviteExpiresAt = until;
      out.push(p);
    });
    return out;
  }

  async listPeople(): Promise<PersonRow[]> {
    const [t] = await this.read(PEOPLE.name);
    return this.peopleFrom(t!);
  }

  async assignPersonId(ref: number, fullName: string, personId: string): Promise<void> {
    const [t] = await this.read(PEOPLE.name);
    const row = t!.rows[ref - 2];
    if (!row || str(this.cell(t!, row, P.fullName)) !== fullName || str(this.cell(t!, row, P.id))) {
      throw new Error(`Строка ${ref} реестра изменилась, ID не присвоен`);
    }
    const col = columnLetter(t!.header.get(P.id)!);
    await this.gw.batchUpdate([{ range: `${q(PEOPLE.name)}!${col}${ref}`, values: [[personId]] }]);
  }

  async patchPerson(personId: string, patch: PersonPatch): Promise<void> {
    const [t] = await this.read(PEOPLE.name);
    const rowNumber = await this.findRow(PEOPLE.name, t!, P.id, personId);
    if (!rowNumber) throw new Error(`В People нет ${personId}`);
    const values: Record<string, Cell> = {};
    const put = <V>(header: string, v: V | null | undefined, enc: (v: V) => Cell) => {
      if (v === undefined) return;
      values[header] = v === null ? '' : enc(v);
    };
    put(P.telegramId, patch.telegramUserId, (v) => v);
    put(P.telegram, patch.telegramUsername, (v) => `@${v}`);
    put(P.boundAt, patch.boundAt, (v) => this.fmt(v));
    put(P.invite, patch.inviteCode, (v) => `${this.opts.inviteLinkBase}${v}`);
    put(P.inviteUntil, patch.inviteExpiresAt, (v) => this.fmt(v));
    put(P.publish, patch.publish, (v) => (v ? 'да' : 'нет'));
    put(P.note, patch.note, (v) => v);
    const data = Object.entries(values).flatMap(([header, value]) => {
      const i = t!.header.get(header);
      if (i === undefined) return [];
      return [{ range: `${q(PEOPLE.name)}!${columnLetter(i)}${rowNumber}`, values: [[value]] }];
    });
    await this.gw.batchUpdate(data);
  }

  /* ───── Profiles ───── */

  private profilesFrom(t: Table): Profile[] {
    this.require(t, PROFILES.name, [PR.id, PR.publication]);
    const out: Profile[] = [];
    for (const row of t.rows) {
      if (isEmptyRow(row)) continue;
      const c = (h: string) => this.cell(t, row, h);
      const personId = str(c(PR.id));
      if (!personId) continue;
      const fields: ProfileFields = {};
      for (const f of FIELDS) {
        const v = str(c(f.label));
        if (v) fields[f.key] = v;
      }
      const p: Profile = {
        personId,
        fullName: str(c(PR.fullName)),
        publication: PUBLICATION_BY_LABEL.get(str(c(PR.publication)).toLowerCase()) ?? 'none',
        fields,
      };
      const pageUrl = str(c(PR.pageUrl));
      if (pageUrl) p.pageUrl = pageUrl;
      const photo = str(c(PR.photo));
      if (photo) p.photo = photo;
      const updatedAt = this.date(c(PR.updatedAt));
      if (updatedAt) p.updatedAt = updatedAt;
      const last = str(c(PR.lastRequest));
      if (last) p.lastRequestId = last;
      out.push(p);
    }
    return out;
  }

  async listProfiles(): Promise<Profile[]> {
    const [t] = await this.read(PROFILES.name);
    return this.profilesFrom(t!);
  }

  async saveProfile(profile: Profile): Promise<void> {
    const [t] = await this.read(PROFILES.name);
    const values: Record<string, Cell> = {
      [PR.id]: profile.personId,
      [PR.fullName]: profile.fullName,
      [PR.pageUrl]: profile.pageUrl ?? '',
      [PR.publication]: PUBLICATION_LABELS[profile.publication],
      [PR.photo]: profile.photo ?? '',
      [PR.updatedAt]: this.fmt(profile.updatedAt),
      [PR.lastRequest]: profile.lastRequestId ?? '',
    };
    for (const f of FIELDS) values[f.label] = profile.fields[f.key] ?? '';
    const row = this.rowOf(t!, values);
    const rowNumber = await this.findRow(PROFILES.name, t!, PR.id, profile.personId);
    if (rowNumber) {
      await this.gw.batchUpdate([
        { range: this.rowRange(PROFILES.name, t!, rowNumber), values: [row] },
      ]);
    } else {
      await this.gw.append(`${q(PROFILES.name)}!A1`, [row]);
    }
  }

  /* ───── Requests ───── */

  private requestsFrom(t: Table): Request[] {
    this.require(t, REQUESTS.name, [RQ.id, RQ.type, RQ.personId, RQ.status, RQ.changed]);
    const out: Request[] = [];
    for (const row of t.rows) {
      if (isEmptyRow(row)) continue;
      const c = (h: string) => this.cell(t, row, h);
      const requestId = str(c(RQ.id));
      const type = TYPE_BY_LABEL.get(str(c(RQ.type)).toLowerCase());
      const status = STATUS_BY_LABEL.get(str(c(RQ.status)).toLowerCase());
      if (!requestId || !type || !status) continue;

      const fields: ProfileFields = {};
      for (const label of str(c(RQ.changed)).split(',')) {
        const key = FIELD_BY_LABEL.get(label.trim().toLowerCase());
        if (key) fields[key] = str(c(FIELD_BY_KEY[key].label));
      }
      const createdAt = this.date(c(RQ.createdAt)) ?? new Date(0);
      const r: Request = {
        requestId,
        type: type as RequestType,
        personId: str(c(RQ.personId)),
        fullName: str(c(RQ.fullName)),
        status: status as RequestStatus,
        initiator: (INITIATOR_BY_LABEL.get(str(c(RQ.initiator)).toLowerCase()) ??
          'person') as Initiator,
        createdAt,
        statusSince: this.date(c(RQ.statusSince)) ?? createdAt,
        updatedAt: this.date(c(RQ.updatedAt)) ?? createdAt,
        fields,
      };
      const set = <K extends keyof Request>(key: K, value: Request[K] | undefined) => {
        if (value !== undefined && value !== '') r[key] = value;
      };
      set('assigneeId', num(c(RQ.assigneeId)));
      set('assigneeName', str(c(RQ.assignee)) || undefined);
      set('submittedAt', this.date(c(RQ.submittedAt)));
      set('publishedAt', this.date(c(RQ.publishedAt)));
      set('closedAt', this.date(c(RQ.closedAt)));
      set('dueAt', this.date(c(RQ.due)));
      set('lastReminderAt', this.date(c(RQ.reminder)));
      set('closeReason', str(c(RQ.closeReason)) || undefined);
      set('photo', str(c(RQ.photo)) || undefined);
      set('pageUrl', str(c(RQ.pageUrl)) || undefined);
      set('requesterNote', str(c(RQ.requesterNote)) || undefined);
      set('editorNote', str(c(RQ.editorNote)) || undefined);
      set('cardMessageId', num(c(RQ.card)));
      out.push(r);
    }
    return out;
  }

  private requestValues(r: Request): Record<string, Cell> {
    const ball = ballOf(r.status);
    const changed = (Object.keys(r.fields) as FieldKey[]).map((k) => FIELD_BY_KEY[k].label);
    const values: Record<string, Cell> = {
      [RQ.id]: r.requestId,
      [RQ.type]: REQUEST_TYPE_LABELS[r.type],
      [RQ.personId]: r.personId,
      [RQ.fullName]: r.fullName,
      [RQ.status]: STATUS_LABELS[r.status],
      [RQ.ball]: ball ? BALL_LABELS[ball] : '—',
      [RQ.due]: this.fmt(r.dueAt),
      [RQ.initiator]: INITIATOR_LABELS[r.initiator],
      [RQ.assignee]: r.assigneeName ?? '',
      [RQ.createdAt]: this.fmt(r.createdAt),
      [RQ.statusSince]: this.fmt(r.statusSince),
      [RQ.submittedAt]: this.fmt(r.submittedAt),
      [RQ.publishedAt]: this.fmt(r.publishedAt),
      [RQ.closedAt]: this.fmt(r.closedAt),
      [RQ.closeReason]: r.closeReason ?? '',
      [RQ.changed]: changed.join(', '),
      [RQ.photo]: r.photo ?? '',
      [RQ.pageUrl]: r.pageUrl ?? '',
      [RQ.requesterNote]: r.requesterNote ?? '',
      [RQ.editorNote]: r.editorNote ?? '',
      [RQ.assigneeId]: r.assigneeId ?? '',
      [RQ.card]: r.cardMessageId ?? '',
      [RQ.reminder]: this.fmt(r.lastReminderAt),
      [RQ.updatedAt]: this.fmt(r.updatedAt),
    };
    for (const f of FIELDS) values[f.label] = r.fields[f.key] ?? '';
    return values;
  }

  async listRequests(): Promise<Request[]> {
    const [t] = await this.read(REQUESTS.name);
    return this.requestsFrom(t!);
  }

  async getRequest(requestId: string): Promise<Request | undefined> {
    return (await this.listRequests()).find((r) => r.requestId === requestId);
  }

  async nextRequestId(): Promise<string> {
    const [t] = await this.read(REQUESTS.name);
    const col = t!.header.get(RQ.id) ?? 0;
    const max = t!.rows.reduce((m, row) => Math.max(m, parseRequestNumber(str(row[col]))), 0);
    return formatRequestId(max + 1);
  }

  async insertRequest(request: Request): Promise<void> {
    const [t] = await this.read(REQUESTS.name);
    if (await this.findRow(REQUESTS.name, t!, RQ.id, request.requestId)) {
      throw new Error(`Заявка ${request.requestId} уже есть`);
    }
    await this.gw.append(`${q(REQUESTS.name)}!A1`, [this.rowOf(t!, this.requestValues(request))]);
  }

  async updateRequest(request: Request): Promise<void> {
    const [t] = await this.read(REQUESTS.name);
    const rowNumber = await this.findRow(REQUESTS.name, t!, RQ.id, request.requestId);
    if (!rowNumber) throw new Error(`Нет заявки ${request.requestId}`);
    await this.gw.batchUpdate([
      {
        range: this.rowRange(REQUESTS.name, t!, rowNumber),
        values: [this.rowOf(t!, this.requestValues(request))],
      },
    ]);
  }

  /* ───── History, Settings, снимок ───── */

  async appendHistory(events: HistoryEvent[]): Promise<void> {
    if (!events.length) return;
    const [t] = await this.read(HISTORY.name);
    const rows = events.map((e) =>
      this.rowOf(t!, {
        [H.at]: this.fmt(e.at),
        [H.requestId]: e.requestId ?? '',
        [H.personId]: e.personId ?? '',
        [H.event]: e.event,
        [H.from]: e.from ?? '',
        [H.to]: e.to ?? '',
        [H.actor]: e.actor,
        [H.details]: e.details ?? '',
      }),
    );
    await this.gw.append(`${q(HISTORY.name)}!A1`, rows);
  }

  async loadSettings(): Promise<Settings> {
    const [t] = await this.read(SETTINGS.name);
    const settings: Settings = { ...DEFAULT_SETTINGS, holidays: [], workdays: [] };
    const int = (v: unknown, fallback: number, min: number, max: number) => {
      const n = num(v);
      return n !== undefined && Number.isInteger(n) && n >= min && n <= max ? n : fallback;
    };
    for (const row of t!.rows) {
      const key = str(this.cell(t!, row, S.key));
      const value = this.cell(t!, row, S.value);
      switch (key) {
        case SETTING_KEYS.editorDays:
          settings.editorDays = int(value, DEFAULT_SETTINGS.editorDays, 1, 30);
          break;
        case SETTING_KEYS.reviewDays:
          settings.reviewDays = int(value, DEFAULT_SETTINGS.reviewDays, 1, 30);
          break;
        case SETTING_KEYS.reminderDays:
          settings.reminderDays = int(value, DEFAULT_SETTINGS.reminderDays, 1, 30);
          break;
        case SETTING_KEYS.updateDraftDays:
          settings.updateDraftDays = int(value, DEFAULT_SETTINGS.updateDraftDays, 1, 90);
          break;
        case SETTING_KEYS.inviteDays:
          settings.inviteDays = int(value, DEFAULT_SETTINGS.inviteDays, 1, 365);
          break;
        case SETTING_KEYS.digestTime:
          settings.digestTime = parseTime(value) ?? DEFAULT_SETTINGS.digestTime;
          break;
        case SETTING_KEYS.holiday: {
          const d = parseDateKey(value, this.opts.tz);
          if (d) settings.holidays.push(d);
          break;
        }
        case SETTING_KEYS.workday: {
          const d = parseDateKey(value, this.opts.tz);
          if (d) settings.workdays.push(d);
          break;
        }
      }
    }
    return settings;
  }

  async snapshot(): Promise<Snapshot> {
    const [people, profiles, requests] = await this.read(PEOPLE.name, PROFILES.name, REQUESTS.name);
    return {
      people: this.peopleFrom(people!),
      profiles: this.profilesFrom(profiles!),
      requests: this.requestsFrom(requests!),
    };
  }
}

/** «10:00», «10:00:00» или доля суток, если Таблица превратила время в число. */
export function parseTime(v: unknown): string | undefined {
  if (typeof v === 'number' && v >= 0 && v < 1) {
    const minutes = Math.round(v * 24 * 60);
    return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  }
  const m = /^(\d{1,2}):(\d{2})/.exec(str(v));
  if (!m) return undefined;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh > 23 || mm > 59) return undefined;
  return `${String(hh).padStart(2, '0')}:${m[2]}`;
}

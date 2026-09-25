import {
  DEFAULT_SETTINGS,
  type HistoryEvent,
  type Profile,
  type Request,
  type Settings,
} from '../domain/model.js';
import {
  formatRequestId,
  type PersonPatch,
  type PersonRow,
  parseRequestNumber,
  type Repository,
  type Snapshot,
} from './repository.js';

const clone = <T>(v: T): T => structuredClone(v);

/** Хранилище в памяти: для тестов и локального запуска без Google. */
export class MemoryRepository implements Repository {
  people: PersonRow[] = [];
  profiles: Profile[] = [];
  requests: Request[] = [];
  history: HistoryEvent[] = [];
  settings: Settings = { ...DEFAULT_SETTINGS };

  constructor(
    init: Partial<Pick<MemoryRepository, 'profiles' | 'requests' | 'settings'>> & {
      people?: Omit<PersonRow, 'ref'>[];
    } = {},
  ) {
    this.people = (init.people ?? []).map((p, i) => ({ ...clone(p), ref: i + 2 }));
    this.profiles = clone(init.profiles ?? []);
    this.requests = clone(init.requests ?? []);
    if (init.settings) this.settings = clone(init.settings);
  }

  async snapshot(): Promise<Snapshot> {
    return {
      people: await this.listPeople(),
      profiles: await this.listProfiles(),
      requests: await this.listRequests(),
    };
  }

  async listPeople(): Promise<PersonRow[]> {
    return clone(this.people);
  }

  async assignPersonId(ref: number, fullName: string, personId: string): Promise<void> {
    const row = this.people.find((p) => p.ref === ref);
    if (!row || row.fullName !== fullName || row.personId) {
      throw new Error(`Строка ${ref} реестра изменилась, ID не присвоен`);
    }
    row.personId = personId;
  }

  async patchPerson(personId: string, patch: PersonPatch): Promise<void> {
    const row = this.people.find((p) => p.personId === personId);
    if (!row) throw new Error(`Нет человека ${personId}`);
    applyPersonPatch(row, patch);
  }

  async listProfiles(): Promise<Profile[]> {
    return clone(this.profiles);
  }

  async saveProfile(profile: Profile): Promise<void> {
    const i = this.profiles.findIndex((p) => p.personId === profile.personId);
    if (i >= 0) this.profiles[i] = clone(profile);
    else this.profiles.push(clone(profile));
  }

  async listRequests(): Promise<Request[]> {
    return clone(this.requests);
  }

  async getRequest(requestId: string): Promise<Request | undefined> {
    const r = this.requests.find((x) => x.requestId === requestId);
    return r ? clone(r) : undefined;
  }

  async nextRequestId(): Promise<string> {
    const max = this.requests.reduce((m, r) => Math.max(m, parseRequestNumber(r.requestId)), 0);
    return formatRequestId(max + 1);
  }

  async insertRequest(request: Request): Promise<void> {
    if (this.requests.some((r) => r.requestId === request.requestId)) {
      throw new Error(`Заявка ${request.requestId} уже есть`);
    }
    this.requests.push(clone(request));
  }

  async updateRequest(request: Request): Promise<void> {
    const i = this.requests.findIndex((r) => r.requestId === request.requestId);
    if (i < 0) throw new Error(`Нет заявки ${request.requestId}`);
    this.requests[i] = clone(request);
  }

  async appendHistory(events: HistoryEvent[]): Promise<void> {
    this.history.push(...clone(events));
  }

  async loadSettings(): Promise<Settings> {
    return clone(this.settings);
  }
}

export function applyPersonPatch(row: PersonRow, patch: PersonPatch): void {
  const set = <K extends keyof PersonRow>(key: K, value: PersonRow[K] | null | undefined) => {
    if (value === undefined) return;
    if (value === null) delete row[key];
    else row[key] = value;
  };
  set('telegramUserId', patch.telegramUserId);
  set('telegramUsername', patch.telegramUsername);
  set('boundAt', patch.boundAt);
  set('inviteCode', patch.inviteCode);
  set('inviteExpiresAt', patch.inviteExpiresAt);
  if (patch.publish !== undefined) row.publish = patch.publish;
  if (patch.note !== undefined) row.note = patch.note;
}

import type { HistoryEvent, Person, Profile, Request, Settings } from '../domain/model.js';

/** Строка реестра. `ref` — служебная ссылка на строку в хранилище. */
export interface PersonRow extends Person {
  ref: number;
}

/**
 * Что бот имеет право записать в реестр. Остальные колонки People —
 * зона владельца реестра, бот их не трогает. `null` очищает ячейку.
 */
export interface PersonPatch {
  telegramUserId?: number | null;
  telegramUsername?: string | null;
  boundAt?: Date | null;
  inviteCode?: string | null;
  inviteExpiresAt?: Date | null;
  /** Только когда сам человек отказался от страницы */
  publish?: boolean;
  note?: string;
}

export interface Snapshot {
  people: PersonRow[];
  profiles: Profile[];
  requests: Request[];
}

export interface Repository {
  snapshot(): Promise<Snapshot>;
  listPeople(): Promise<PersonRow[]>;
  /** Проставляет ID новой строке, если в ней всё ещё тот же человек без ID */
  assignPersonId(ref: number, fullName: string, personId: string): Promise<void>;
  patchPerson(personId: string, patch: PersonPatch): Promise<void>;

  listProfiles(): Promise<Profile[]>;
  saveProfile(profile: Profile): Promise<void>;

  listRequests(): Promise<Request[]>;
  getRequest(requestId: string): Promise<Request | undefined>;
  nextRequestId(): Promise<string>;
  insertRequest(request: Request): Promise<void>;
  updateRequest(request: Request): Promise<void>;

  appendHistory(events: HistoryEvent[]): Promise<void>;
  loadSettings(): Promise<Settings>;
}

export function formatRequestId(n: number): string {
  return `R-${String(n).padStart(4, '0')}`;
}

export function parseRequestNumber(id: string): number {
  const m = /^R-(\d+)$/.exec(id.trim());
  return m ? Number(m[1]) : 0;
}

export function formatPersonId(n: number): string {
  return `P${String(n).padStart(3, '0')}`;
}

export function parsePersonNumber(id: string): number {
  const m = /^P(\d+)$/.exec(id.trim());
  return m ? Number(m[1]) : 0;
}

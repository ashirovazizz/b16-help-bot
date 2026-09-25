import { silentLogger } from '../src/core/logger.js';
import { type Clock, parseDateTime } from '../src/core/time.js';
import { LinkSigner } from '../src/core/tokens.js';
import type { Profile } from '../src/domain/model.js';
import { MemoryPhotoStore } from '../src/photos/memory.js';
import { Links } from '../src/services/links.js';
import type {
  Attachment,
  CardView,
  Notifier,
  OutMessage,
  SiteChecker,
} from '../src/services/ports.js';
import { RequestService } from '../src/services/service.js';
import { MemoryRepository } from '../src/storage/memory.js';
import type { PersonRow } from '../src/storage/repository.js';

export const TZ = 'Europe/Moscow';
export const at = (s: string) => parseDateTime(s, TZ)!;

export class TestClock implements Clock {
  constructor(public current: Date) {}
  now() {
    return new Date(this.current);
  }
  set(s: string) {
    this.current = at(s);
  }
}

export class FakeNotifier implements Notifier {
  cards = new Map<number, CardView>();
  cardLog: CardView[] = [];
  notes: { requestId: string; text: string; attachment?: Attachment }[] = [];
  dms: { userId: number; message: OutMessage }[] = [];
  ops: string[] = [];
  alerts: string[] = [];
  private nextId = 1000;
  failCards = false;

  async upsertCard(card: CardView) {
    if (this.failCards) throw new Error('telegram down');
    this.cardLog.push(card);
    const id = card.request.cardMessageId ?? this.nextId++;
    this.cards.set(id, card);
    return id;
  }
  async noteToEditors(request: { requestId: string }, text: string, attachment?: Attachment) {
    this.notes.push({ requestId: request.requestId, text, ...(attachment ? { attachment } : {}) });
  }
  async sendToUser(userId: number, message: OutMessage) {
    this.dms.push({ userId, message });
  }
  async postToOps(text: string) {
    this.ops.push(text);
  }
  async alert(text: string) {
    this.alerts.push(text);
  }
  lastDm(userId: number) {
    return [...this.dms].reverse().find((d) => d.userId === userId)?.message;
  }
}

export class FakeSite implements SiteChecker {
  statuses = new Map<string, number>();
  isSiteUrl(url: string) {
    return url.startsWith('https://dh.itmo.ru/');
  }
  async status(url: string) {
    return this.statuses.get(url) ?? 200;
  }
}

/** Минимальный PNG нужного размера: image-size читает только заголовок. */
export function fakePng(width = 800, height = 1000): Uint8Array {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  buf.writeUInt8(8, 24);
  buf.writeUInt8(2, 25);
  return new Uint8Array(buf);
}

export const people = {
  aziz: {
    personId: 'P001',
    fullName: 'Азиз Аширов',
    category: 'сотрудники',
    orgRole: 'координатор программ развития',
    status: 'active',
    publish: true,
    note: '',
    telegramUserId: 501,
  },
  masha: {
    personId: 'P002',
    fullName: 'Мария Кешишян',
    category: 'сотрудники',
    orgRole: 'координатор интеллектуальной жизни',
    status: 'active',
    publish: true,
    note: '',
    telegramUserId: 502,
  },
  newbie: {
    personId: 'P003',
    fullName: 'Новый Преподаватель',
    category: 'преподаватели',
    orgRole: 'преподаватель',
    status: 'active',
    publish: true,
    note: '',
  },
} satisfies Record<string, Omit<PersonRow, 'ref'>>;

export const profiles: Record<string, Profile> = {
  aziz: {
    personId: 'P001',
    fullName: 'Азиз Аширов',
    pageUrl: 'https://dh.itmo.ru/ashirov',
    publication: 'published',
    fields: { title: 'координатор', about: 'Старый текст' },
    photo: 'memory://old.jpg',
  },
  masha: {
    personId: 'P002',
    fullName: 'Мария Кешишян',
    pageUrl: 'https://dh.itmo.ru/keshishian',
    publication: 'published',
    fields: { title: 'координатор интеллектуальной жизни', about: 'Про библиотеку' },
  },
};

export const vika = { kind: 'editor' as const, id: 900, name: 'Вика' };
export const otherEditor = { kind: 'editor' as const, id: 901, name: 'Маша' };

export function setup(opts: { people?: Omit<PersonRow, 'ref'>[]; profiles?: Profile[] } = {}) {
  const clock = new TestClock(at('2026-09-28 10:00'));
  const repo = new MemoryRepository({
    people: opts.people ?? [people.aziz, people.masha, people.newbie],
    profiles: opts.profiles ?? [profiles.aziz!, profiles.masha!],
  });
  const notifier = new FakeNotifier();
  const photos = new MemoryPhotoStore();
  const site = new FakeSite();
  const links = new Links(new LinkSigner('s'.repeat(40)), 'https://forms.example.org', clock);
  const service = new RequestService({
    repo,
    notifier,
    photos,
    links,
    clock,
    tz: TZ,
    log: silentLogger,
    site,
    settingsTtlMs: 0,
  });
  return { clock, repo, notifier, photos, site, links, service };
}

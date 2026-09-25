import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Случайный код для ссылки-приглашения: 22 символа [A-Za-z0-9_-], ~128 бит. */
export function randomCode(bytes = 16): string {
  return randomBytes(bytes).toString('base64url');
}

/** Кто открывает форму: заявитель или редактор. */
export type LinkRole = 'requester' | 'editor';

const ROLE_CHAR: Record<LinkRole, string> = { requester: 'r', editor: 'e' };
const CHAR_ROLE: Record<string, LinkRole> = { r: 'requester', e: 'editor' };

/**
 * Подписанные ссылки на форму заявки. Токен привязан к заявке, роли и сроку:
 * `r<срок в base36>.<подпись>`. Подделать или переиспользовать для другой
 * заявки нельзя, а просроченная ссылка перестаёт работать.
 */
export class LinkSigner {
  constructor(private readonly secret: string) {
    if (secret.length < 32) throw new Error('LINK_SECRET должен быть не короче 32 символов');
  }

  private signature(requestId: string, role: string, exp: string): string {
    return createHmac('sha256', this.secret)
      .update(`${requestId}|${role}|${exp}`)
      .digest('base64url')
      .slice(0, 22);
  }

  sign(requestId: string, role: LinkRole, expiresAt: Date): string {
    const r = ROLE_CHAR[role];
    const exp = Math.floor(expiresAt.getTime() / 1000).toString(36);
    return `${r}${exp}.${this.signature(requestId, r, exp)}`;
  }

  verify(requestId: string, token: string, now: Date): LinkRole | null {
    const m = /^([re])([0-9a-z]{1,12})\.([A-Za-z0-9_-]{22})$/.exec(token);
    if (!m) return null;
    const [, r, exp, sig] = m as unknown as [string, string, string, string];
    const expected = Buffer.from(this.signature(requestId, r, exp));
    const given = Buffer.from(sig);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    if (Number.parseInt(exp, 36) * 1000 < now.getTime()) return null;
    return CHAR_ROLE[r] ?? null;
  }
}

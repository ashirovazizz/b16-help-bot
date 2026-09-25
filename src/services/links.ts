import type { Clock } from '../core/time.js';
import { DAY_MS } from '../core/time.js';
import type { LinkRole, LinkSigner } from '../core/tokens.js';

const TTL_DAYS: Record<LinkRole, number> = { requester: 14, editor: 60 };

/** Ссылки на форму заявки: для заявителя и для редактора. */
export class Links {
  private readonly base: string;

  constructor(
    private readonly signer: LinkSigner,
    publicBaseUrl: string,
    private readonly clock: Clock,
  ) {
    this.base = publicBaseUrl.replace(/\/+$/, '');
  }

  token(requestId: string, role: LinkRole): string {
    const exp = new Date(this.clock.now().getTime() + TTL_DAYS[role] * DAY_MS);
    return this.signer.sign(requestId, role, exp);
  }

  form(requestId: string, role: LinkRole): string {
    return `${this.base}/r/${encodeURIComponent(requestId)}?t=${this.token(requestId, role)}`;
  }

  verify(requestId: string, token: string): LinkRole | null {
    return this.signer.verify(requestId, token, this.clock.now());
  }
}

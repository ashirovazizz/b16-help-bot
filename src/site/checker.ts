import type { SiteChecker } from '../services/ports.js';

/** Проверяет публичный сайт: принадлежит ли ссылка сайту и открывается ли страница. */
export class HttpSiteChecker implements SiteChecker {
  private readonly host: string;

  constructor(
    siteBaseUrl: string,
    private readonly timeoutMs = 10000,
  ) {
    this.host = new URL(siteBaseUrl).host;
  }

  isSiteUrl(url: string): boolean {
    try {
      const u = new URL(url);
      return u.protocol === 'https:' && (u.host === this.host || u.host.endsWith(`.${this.host}`));
    } catch {
      return false;
    }
  }

  async status(url: string): Promise<number> {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: { 'user-agent': 'b16-help-bot (проверка публикации)' },
    });
    await res.body?.cancel();
    return res.status;
  }
}

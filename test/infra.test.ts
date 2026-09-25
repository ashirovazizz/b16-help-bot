import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { driveFileId, driveViewUrl } from '../src/photos/drive.js';
import { HttpSiteChecker } from '../src/site/checker.js';
import { columnLetter } from '../src/storage/sheets/schema.js';
import { PROMPTS, parsePrompt } from '../src/telegram/render.js';

const base = {
  TELEGRAM_BOT_TOKEN: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  OPS_CHAT_ID: '-1001234567890',
  PUBLIC_BASE_URL: 'https://forms.example.org',
  LINK_SECRET: 'x'.repeat(40),
};

describe('config', () => {
  it('в режиме памяти Google не нужен', () => {
    const c = loadConfig({ ...base, STORAGE: 'memory', OPS_TOPIC_ID: '' });
    expect(c.OPS_CHAT_ID).toBe(-1001234567890);
    expect(c.OPS_TOPIC_ID).toBeUndefined();
    expect(c.SITE_BASE_URL).toBe('https://dh.itmo.ru');
    expect(c.REGISTRY_SYNC_MINUTES).toBe(5);
  });

  it('для таблиц требует доступы Google и называет, каких не хватает', () => {
    expect(() => loadConfig(base)).toThrow(/GOOGLE_REFRESH_TOKEN: нужно при STORAGE=sheets/);
  });

  it('объясняет по-русски, чего не хватает', () => {
    expect(() => loadConfig({})).toThrow(/TELEGRAM_BOT_TOKEN: не задано/);
    expect(() => loadConfig({ ...base, LINK_SECRET: 'короткий', STORAGE: 'memory' })).toThrow(
      /не короче 32/,
    );
  });
});

describe('мелочи инфраструктуры', () => {
  it('узнаёт ссылки на сайт центра', () => {
    const site = new HttpSiteChecker('https://dh.itmo.ru');
    expect(site.isSiteUrl('https://dh.itmo.ru/team-member')).toBe(true);
    expect(site.isSiteUrl('https://www.dh.itmo.ru/x')).toBe(true);
    expect(site.isSiteUrl('http://dh.itmo.ru/x')).toBe(false);
    expect(site.isSiteUrl('https://dh.itmo.ru.evil.com/x')).toBe(false);
    expect(site.isSiteUrl('не ссылка')).toBe(false);
  });

  it('достаёт id файла из ссылок Drive', () => {
    expect(driveFileId(driveViewUrl('1AbC-_x'))).toBe('1AbC-_x');
    expect(driveFileId('https://drive.google.com/open?id=XYZ123')).toBe('XYZ123');
    expect(driveFileId('https://static.tildacdn.com/photo.jpg')).toBeUndefined();
  });

  it('буквы колонок', () => {
    expect([0, 25, 26, 27, 51, 52, 701, 702].map(columnLetter)).toEqual([
      'A',
      'Z',
      'AA',
      'AB',
      'AZ',
      'BA',
      'ZZ',
      'AAA',
    ]);
  });

  it('распознаёт подсказки бота по первой строке', () => {
    expect(parsePrompt(`${PROMPTS.needInfo} R-0012\nВика, напишите…`)).toEqual({
      kind: 'needInfo',
      requestId: 'R-0012',
    });
    expect(parsePrompt(`${PROMPTS.pageUrl} R-0003`)?.kind).toBe('pageUrl');
    expect(parsePrompt('Просто сообщение про R-0012')).toBeUndefined();
    expect(parsePrompt(undefined)).toBeUndefined();
  });
});

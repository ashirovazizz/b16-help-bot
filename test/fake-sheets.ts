import type { Cell, SheetsGateway } from '../src/storage/sheets/gateway.js';
import { ALL_SHEETS, SETTING_KEYS } from '../src/storage/sheets/schema.js';

const colIndex = (letters: string) =>
  [...letters.toUpperCase()].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1;

interface Parsed {
  sheet: string;
  c1: number;
  r1: number;
  c2: number;
  r2: number;
}

function parse(range: string): Parsed {
  const m = /^'((?:[^']|'')+)'(?:!([A-Z]+)(\d+)?(?::([A-Z]+)(\d+)?)?)?$/.exec(range);
  if (!m) throw new Error(`Непонятный диапазон ${range}`);
  const sheet = m[1]!.replace(/''/g, "'");
  if (!m[2])
    return { sheet, c1: 0, r1: 0, c2: Number.POSITIVE_INFINITY, r2: Number.POSITIVE_INFINITY };
  const c1 = colIndex(m[2]);
  const r1 = m[3] ? Number(m[3]) - 1 : 0;
  const c2 = m[4] ? colIndex(m[4]) : c1;
  const r2 = m[5] ? Number(m[5]) - 1 : m[4] || !m[3] ? Number.POSITIVE_INFINITY : r1;
  return { sheet, c1, r1, c2, r2 };
}

/** Таблица в памяти с поведением Sheets API: обрезает пустые хвосты, null не трогает ячейку. */
export class FakeSheets implements SheetsGateway {
  readonly grids = new Map<string, Cell[][]>();
  calls = { get: 0, update: 0, append: 0 };

  constructor(init: Record<string, Cell[][]> = {}) {
    for (const [k, v] of Object.entries(init))
      this.grids.set(
        k,
        v.map((r) => [...r]),
      );
  }

  static workbook(extra: Record<string, Cell[][]> = {}): FakeSheets {
    const init: Record<string, Cell[][]> = {};
    for (const s of ALL_SHEETS) init[s.name] = [s.columns.map((c) => c.header)];
    init.Settings!.push(
      [SETTING_KEYS.editorDays, 3, ''],
      [SETTING_KEYS.reviewDays, 2, ''],
      [SETTING_KEYS.digestTime, '10:00', ''],
    );
    for (const [k, rows] of Object.entries(extra)) init[k]!.push(...rows);
    return new FakeSheets(init);
  }

  grid(sheet: string): Cell[][] {
    const g = this.grids.get(sheet);
    if (!g) throw new Error(`Нет листа ${sheet}`);
    return g;
  }

  async batchGet(ranges: string[]): Promise<unknown[][][]> {
    this.calls.get++;
    return ranges.map((range) => {
      const p = parse(range);
      const g = this.grid(p.sheet);
      const rows = g
        .slice(p.r1, p.r2 === Number.POSITIVE_INFINITY ? undefined : p.r2 + 1)
        .map((row) => {
          const cut = row.slice(p.c1, p.c2 === Number.POSITIVE_INFINITY ? undefined : p.c2 + 1);
          while (cut.length && (cut[cut.length - 1] === '' || cut[cut.length - 1] == null))
            cut.pop();
          return cut.map((c) => (c == null ? '' : c));
        });
      while (rows.length && rows[rows.length - 1]!.length === 0) rows.pop();
      return rows;
    });
  }

  async batchUpdate(data: { range: string; values: Cell[][] }[]): Promise<void> {
    this.calls.update++;
    for (const { range, values } of data) {
      const p = parse(range);
      const g = this.grid(p.sheet);
      values.forEach((row, i) => {
        const r = p.r1 + i;
        while (g.length <= r) g.push([]);
        const target = g[r]!;
        row.forEach((v, j) => {
          if (v === null) return;
          while (target.length <= p.c1 + j) target.push('');
          target[p.c1 + j] = v;
        });
      });
    }
  }

  async append(range: string, values: Cell[][]): Promise<void> {
    this.calls.append++;
    const g = this.grid(parse(range).sheet);
    let last = g.length - 1;
    while (last >= 0 && g[last]!.every((c) => c === '' || c == null)) last--;
    g.splice(last + 1, 0, ...values.map((row) => row.map((c) => (c === null ? '' : c))));
  }
}

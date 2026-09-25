import type { sheets_v4 } from '@googleapis/sheets';

export type Cell = string | number | boolean | null;

/** Минимальный доступ к значениям таблицы. Реализации: Google Sheets API и подделка для тестов. */
export interface SheetsGateway {
  batchGet(ranges: string[]): Promise<unknown[][][]>;
  /** RAW-запись: null — не трогать ячейку, '' — очистить */
  batchUpdate(data: { range: string; values: Cell[][] }[]): Promise<void>;
  append(range: string, values: Cell[][]): Promise<void>;
}

function statusOf(e: unknown): number | undefined {
  const err = e as { status?: number; code?: number | string; response?: { status?: number } };
  const s =
    err.response?.status ?? err.status ?? (typeof err.code === 'number' ? err.code : undefined);
  return typeof s === 'number' ? s : undefined;
}

/** Повтор при перегрузке API (429) и временных ошибках Google (5xx). */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  let delay = 1000;
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const status = statusOf(e);
      const retriable = status === 429 || (status !== undefined && status >= 500);
      if (!retriable || i >= attempts) throw e;
      await new Promise((r) => setTimeout(r, delay));
      delay *= 2;
    }
  }
}

export class GoogleSheetsGateway implements SheetsGateway {
  constructor(
    private readonly api: sheets_v4.Sheets,
    private readonly spreadsheetId: string,
  ) {}

  async batchGet(ranges: string[]): Promise<unknown[][][]> {
    const res = await withRetry(() =>
      this.api.spreadsheets.values.batchGet({
        spreadsheetId: this.spreadsheetId,
        ranges,
        valueRenderOption: 'UNFORMATTED_VALUE',
        dateTimeRenderOption: 'FORMATTED_STRING',
      }),
    );
    return (res.data.valueRanges ?? []).map((v) => (v.values ?? []) as unknown[][]);
  }

  async batchUpdate(data: { range: string; values: Cell[][] }[]): Promise<void> {
    if (!data.length) return;
    await withRetry(() =>
      this.api.spreadsheets.values.batchUpdate({
        spreadsheetId: this.spreadsheetId,
        requestBody: { valueInputOption: 'RAW', data },
      }),
    );
  }

  async append(range: string, values: Cell[][]): Promise<void> {
    await withRetry(() =>
      this.api.spreadsheets.values.append({
        spreadsheetId: this.spreadsheetId,
        range,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values },
      }),
    );
  }
}

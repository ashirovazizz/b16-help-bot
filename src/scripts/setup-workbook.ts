/**
 * Создание или проверка книги и папки для фото на аккаунте центра.
 *
 *   npm run setup:workbook            — локально (нужен .env с доступом к Google)
 *   docker compose run --rm bot node dist/scripts/setup-workbook.js — на сервере
 *
 * Без SPREADSHEET_ID создаёт новую книгу, с ним — проверяет и дополняет листы
 * и заголовки, не сдвигая данные. Без PHOTOS_FOLDER_ID создаёт закрытую папку.
 */
import { drive } from '@googleapis/drive';
import { sheets, type sheets_v4 } from '@googleapis/sheets';
import { DEFAULT_SETTINGS } from '../domain/model.js';
import { googleClient } from '../google/auth.js';
import { withRetry } from '../storage/sheets/gateway.js';
import {
  ALL_SHEETS,
  columnLetter,
  PEOPLE,
  q,
  SETTING_HINTS,
  SETTING_KEYS,
  SETTINGS,
  type SheetDef,
} from '../storage/sheets/schema.js';

const env = process.env;
for (const key of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN']) {
  if (!env[key]) {
    console.error(`Нет ${key} в окружении. Сначала выполните npm run google:auth.`);
    process.exit(1);
  }
}

const auth = googleClient({
  clientId: env.GOOGLE_CLIENT_ID!,
  clientSecret: env.GOOGLE_CLIENT_SECRET!,
  refreshToken: env.GOOGLE_REFRESH_TOKEN!,
});
const sheetsApi = sheets({ version: 'v4', auth });
const driveApi = drive({ version: 'v3', auth });
const tz = env.TIMEZONE || 'Europe/Moscow';

const settingsRows = (): (string | number)[][] => [
  [SETTING_KEYS.editorDays, DEFAULT_SETTINGS.editorDays, SETTING_HINTS.editorDays],
  [SETTING_KEYS.reviewDays, DEFAULT_SETTINGS.reviewDays, SETTING_HINTS.reviewDays],
  [SETTING_KEYS.reminderDays, DEFAULT_SETTINGS.reminderDays, SETTING_HINTS.reminderDays],
  [SETTING_KEYS.updateDraftDays, DEFAULT_SETTINGS.updateDraftDays, SETTING_HINTS.updateDraftDays],
  [SETTING_KEYS.inviteDays, DEFAULT_SETTINGS.inviteDays, SETTING_HINTS.inviteDays],
  [SETTING_KEYS.digestTime, DEFAULT_SETTINGS.digestTime, SETTING_HINTS.digestTime],
  [SETTING_KEYS.holiday, '2026-11-04', SETTING_HINTS.holiday],
  [SETTING_KEYS.holiday, '2026-12-31', ''],
  [SETTING_KEYS.workday, '', SETTING_HINTS.workday],
];

/** Оформление листа: закреплённая шапка, ширины, списки, защита служебных колонок. */
function formatRequests(
  def: SheetDef,
  sheetId: number,
  header: string[],
): sheets_v4.Schema$Request[] {
  const reqs: sheets_v4.Schema$Request[] = [
    {
      updateSheetProperties: {
        properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
        fields: 'gridProperties.frozenRowCount',
      },
    },
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
        cell: {
          userEnteredFormat: {
            textFormat: { bold: true },
            backgroundColor: { red: 0.93, green: 0.92, blue: 0.89 },
            wrapStrategy: 'WRAP',
            verticalAlignment: 'MIDDLE',
          },
        },
        fields: 'userEnteredFormat(textFormat,backgroundColor,wrapStrategy,verticalAlignment)',
      },
    },
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 1 },
        cell: { userEnteredFormat: { wrapStrategy: 'CLIP', verticalAlignment: 'TOP' } },
        fields: 'userEnteredFormat(wrapStrategy,verticalAlignment)',
      },
    },
  ];
  for (const col of def.columns) {
    const i = header.indexOf(col.header);
    if (i < 0) continue;
    if (col.width) {
      reqs.push({
        updateDimensionProperties: {
          range: { sheetId, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 },
          properties: { pixelSize: col.width },
          fields: 'pixelSize',
        },
      });
    }
    if (col.options) {
      reqs.push({
        setDataValidation: {
          range: {
            sheetId,
            startRowIndex: 1,
            endRowIndex: 1000,
            startColumnIndex: i,
            endColumnIndex: i + 1,
          },
          rule: {
            condition: {
              type: 'ONE_OF_LIST',
              values: col.options.map((v) => ({ userEnteredValue: v })),
            },
            showCustomUi: true,
            // категорию можно вписать свою, остальное — только из списка
            strict: def !== PEOPLE || col.header !== 'Категория',
          },
        },
      });
    }
    if (col.bot && !def.botOwned) {
      reqs.push({
        addProtectedRange: {
          protectedRange: {
            range: { sheetId, startRowIndex: 1, startColumnIndex: i, endColumnIndex: i + 1 },
            description: 'Заполняет бот',
            warningOnly: true,
          },
        },
      });
    }
  }
  if (def.botOwned) {
    reqs.push({
      addProtectedRange: {
        protectedRange: {
          range: { sheetId },
          description: 'Лист ведёт бот — правьте только в крайнем случае',
          warningOnly: true,
        },
      },
    });
  }
  return reqs;
}

async function createWorkbook(): Promise<string> {
  const res = await withRetry(() =>
    sheetsApi.spreadsheets.create({
      requestBody: {
        properties: { title: 'DH-бот: персональные страницы', locale: 'ru_RU', timeZone: tz },
        sheets: ALL_SHEETS.map((s) => ({ properties: { title: s.name } })),
      },
    }),
  );
  return res.data.spreadsheetId!;
}

async function ensureWorkbook(spreadsheetId: string, fresh: boolean): Promise<string[]> {
  const report: string[] = [];
  const meta = await withRetry(() =>
    sheetsApi.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' }),
  );
  const existing = new Map(
    (meta.data.sheets ?? []).map((s) => [s.properties?.title ?? '', s.properties?.sheetId ?? 0]),
  );

  const missing = ALL_SHEETS.filter((s) => !existing.has(s.name));
  if (missing.length) {
    const res = await withRetry(() =>
      sheetsApi.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: missing.map((s) => ({ addSheet: { properties: { title: s.name } } })),
        },
      }),
    );
    res.data.replies?.forEach((r, i) => {
      existing.set(missing[i]!.name, r.addSheet?.properties?.sheetId ?? 0);
      report.push(`создан лист ${missing[i]!.name}`);
    });
  }

  const headers = await withRetry(() =>
    sheetsApi.spreadsheets.values.batchGet({
      spreadsheetId,
      ranges: ALL_SHEETS.map((s) => `${q(s.name)}!1:1`),
    }),
  );
  const formatting: sheets_v4.Schema$Request[] = [];
  const writes: sheets_v4.Schema$ValueRange[] = [];
  for (const [i, def] of ALL_SHEETS.entries()) {
    const current = ((headers.data.valueRanges?.[i]?.values?.[0] ?? []) as unknown[]).map((v) =>
      String(v ?? '').trim(),
    );
    const add = def.columns.map((c) => c.header).filter((h) => !current.includes(h));
    const header = [...current, ...add];
    if (add.length) {
      // недостающие колонки дописываем справа, чтобы не сдвигать данные
      writes.push({
        range: `${q(def.name)}!${columnLetter(current.length)}1`,
        values: [add],
      });
      report.push(`${def.name}: добавлены колонки ${add.join(', ')}`);
    }
    const isNewSheet = fresh || missing.includes(def) || current.length === 0;
    if (isNewSheet) formatting.push(...formatRequests(def, existing.get(def.name) ?? 0, header));
    if (def === SETTINGS && current.length === 0) {
      writes.push({ range: `${q(def.name)}!A2`, values: settingsRows() });
      report.push('Settings: заполнены значения по умолчанию');
    }
  }
  if (writes.length) {
    await withRetry(() =>
      sheetsApi.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: { valueInputOption: 'RAW', data: writes },
      }),
    );
  }
  if (formatting.length) {
    await withRetry(() =>
      sheetsApi.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: formatting } }),
    );
  }
  // лист по умолчанию «Лист1»/«Sheet1» в новой книге не нужен
  if (fresh) {
    const extra = [...existing.entries()].filter(
      ([name]) => !ALL_SHEETS.some((s) => s.name === name),
    );
    if (extra.length) {
      await withRetry(() =>
        sheetsApi.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: { requests: extra.map(([, sheetId]) => ({ deleteSheet: { sheetId } })) },
        }),
      );
    }
  }
  return report;
}

async function ensureFolder(): Promise<string> {
  if (env.PHOTOS_FOLDER_ID) return env.PHOTOS_FOLDER_ID;
  const res = await withRetry(() =>
    driveApi.files.create({
      requestBody: {
        name: 'DH-бот: фото сотрудников (оригиналы)',
        mimeType: 'application/vnd.google-apps.folder',
      },
      fields: 'id',
    }),
  );
  return res.data.id!;
}

const fresh = !env.SPREADSHEET_ID;
const spreadsheetId = env.SPREADSHEET_ID || (await createWorkbook());
const report = await ensureWorkbook(spreadsheetId, fresh);
const folderId = await ensureFolder();

console.log(fresh ? 'Создана книга:' : 'Проверена книга:');
console.log(`  https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`);
for (const line of report) console.log(`  • ${line}`);
console.log(
  env.PHOTOS_FOLDER_ID ? 'Папка для фото уже задана.' : 'Создана закрытая папка для фото:',
);
console.log(`  https://drive.google.com/drive/folders/${folderId}`);
console.log('\nДобавьте в .env:');
console.log(`SPREADSHEET_ID=${spreadsheetId}`);
console.log(`PHOTOS_FOLDER_ID=${folderId}`);
console.log(
  '\nДоступ к книге для Вики, стажёра и администратора выдайте через «Настройки доступа» в Google Таблице.',
);

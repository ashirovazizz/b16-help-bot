import { Readable } from 'node:stream';
import type { drive_v3 } from '@googleapis/drive';
import type { PhotoStore, StoredPhoto } from '../services/ports.js';
import { withRetry } from '../storage/sheets/gateway.js';

export function driveFileId(ref: string): string | undefined {
  const m = /\/file\/d\/([A-Za-z0-9_-]+)/.exec(ref) ?? /[?&]id=([A-Za-z0-9_-]+)/.exec(ref);
  return m?.[1];
}

export const driveViewUrl = (id: string) => `https://drive.google.com/file/d/${id}/view`;

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

/** Оригиналы фотографий в закрытой папке Drive аккаунта центра. */
export class DrivePhotoStore implements PhotoStore {
  constructor(
    private readonly drive: drive_v3.Drive,
    private readonly folderId: string,
  ) {}

  async save(input: {
    personId: string;
    requestId: string;
    data: Uint8Array;
    mimeType: string;
    ext: string;
  }): Promise<string> {
    const name = `${input.personId}_${input.requestId}_${stamp()}.${input.ext}`;
    const res = await withRetry(() =>
      this.drive.files.create({
        requestBody: { name, parents: [this.folderId] },
        media: { mimeType: input.mimeType, body: Readable.from(Buffer.from(input.data)) },
        fields: 'id',
      }),
    );
    if (!res.data.id) throw new Error('Drive не вернул id файла');
    return driveViewUrl(res.data.id);
  }

  async load(ref: string): Promise<StoredPhoto | undefined> {
    const fileId = driveFileId(ref);
    if (!fileId) return undefined;
    try {
      const meta = await withRetry(() => this.drive.files.get({ fileId, fields: 'mimeType' }));
      const res = await withRetry(() =>
        this.drive.files.get({ fileId, alt: 'media' }, { responseType: 'arraybuffer' }),
      );
      return {
        data: new Uint8Array(res.data as unknown as ArrayBuffer),
        mimeType: meta.data.mimeType ?? 'image/jpeg',
      };
    } catch (e) {
      const status = (e as { status?: number; response?: { status?: number } }).response?.status;
      // файл не наш (например, из старой папки) или удалён
      if (status === 404 || status === 403) return undefined;
      throw e;
    }
  }
}

import type { PhotoStore, StoredPhoto } from '../services/ports.js';

/** Фото в памяти: для тестов и локального запуска. */
export class MemoryPhotoStore implements PhotoStore {
  readonly files = new Map<string, StoredPhoto & { name: string }>();

  async save(input: {
    personId: string;
    requestId: string;
    data: Uint8Array;
    mimeType: string;
    ext: string;
  }): Promise<string> {
    const ref = `memory://${input.personId}_${input.requestId}_${this.files.size + 1}.${input.ext}`;
    this.files.set(ref, {
      name: ref.slice('memory://'.length),
      data: input.data,
      mimeType: input.mimeType,
    });
    return ref;
  }

  async load(ref: string): Promise<StoredPhoto | undefined> {
    const f = this.files.get(ref);
    return f ? { data: f.data, mimeType: f.mimeType } : undefined;
  }
}

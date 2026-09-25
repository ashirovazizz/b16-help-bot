import { imageSize } from 'image-size';
import { PHOTO_RULES } from '../domain/fields.js';

export interface PhotoInfo {
  mimeType: string;
  ext: string;
  width: number;
  height: number;
}

const startsWith = (data: Uint8Array, bytes: number[], offset = 0) =>
  bytes.every((b, i) => data[offset + i] === b);

const ascii = (data: Uint8Array, from: number, to: number) =>
  String.fromCharCode(...data.subarray(from, to));

/** Тип файла по содержимому, а не по имени или заявленному браузером типу. */
export function sniffImageType(data: Uint8Array): { mimeType: string; ext: string } | undefined {
  if (startsWith(data, [0xff, 0xd8, 0xff])) return { mimeType: 'image/jpeg', ext: 'jpg' };
  if (startsWith(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { mimeType: 'image/png', ext: 'png' };
  }
  if (ascii(data, 0, 4) === 'RIFF' && ascii(data, 8, 12) === 'WEBP') {
    return { mimeType: 'image/webp', ext: 'webp' };
  }
  if (ascii(data, 4, 8) === 'ftyp') {
    const brand = ascii(data, 8, 12);
    if (/^(heic|heix|hevc|hevx|mif1|msf1|heif)$/.test(brand)) {
      return { mimeType: 'image/heic', ext: 'heic' };
    }
  }
  return undefined;
}

/** Проверяет фото из формы. Бросает ошибку с понятным человеку текстом. */
export function inspectPhoto(data: Uint8Array): PhotoInfo {
  if (data.byteLength === 0) throw new PhotoError('Файл пустой.');
  if (data.byteLength > PHOTO_RULES.maxBytes) {
    throw new PhotoError(
      `Файл больше ${Math.round(PHOTO_RULES.maxBytes / 1024 / 1024)} МБ. Загрузите фото поменьше.`,
    );
  }
  const kind = sniffImageType(data);
  if (kind?.mimeType === 'image/heic') {
    throw new PhotoError(
      'Формат HEIC сайт не принимает. Сохраните фото как JPEG (на iPhone: «Настройки → Камера → Форматы → Наиболее совместимый») и загрузите снова.',
    );
  }
  if (!kind || !PHOTO_RULES.mimeTypes.includes(kind.mimeType)) {
    throw new PhotoError('Нужна фотография в формате JPEG, PNG или WebP.');
  }
  let size: { width: number; height: number };
  try {
    size = imageSize(data);
  } catch {
    throw new PhotoError('Не получилось прочитать изображение. Попробуйте другой файл.');
  }
  if (Math.min(size.width, size.height) < PHOTO_RULES.minSide) {
    throw new PhotoError(
      `Фото слишком маленькое: ${size.width}×${size.height}. Нужно не меньше ${PHOTO_RULES.minSide} пикселей по короткой стороне.`,
    );
  }
  return { ...kind, width: size.width, height: size.height };
}

export class PhotoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PhotoError';
  }
}

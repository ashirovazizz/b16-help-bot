import type { Request } from '../domain/model.js';

/** Кнопка под сообщением: ссылка или действие бота. */
export type Button = { text: string; url: string } | { text: string; data: string };

export interface OutMessage {
  text: string;
  buttons?: Button[][];
}

export interface Attachment {
  filename: string;
  data: Uint8Array;
  mimeType: string;
}

/** Что показывает карточка заявки в теме «Сайт». */
export interface CardView {
  request: Request;
  /** Ссылка на форму в режиме редактора */
  editorUrl: string;
  /** Срок текущего шага уже прошёл */
  overdue: boolean;
  /** Срок в виде «30.09» */
  dueLabel?: string;
}

/**
 * Куда сервис отправляет сообщения. Реализация — Telegram-бот;
 * в тестах — запись вызовов.
 */
export interface Notifier {
  /** Создаёт или обновляет карточку; возвращает id сообщения карточки */
  upsertCard(card: CardView): Promise<number | undefined>;
  /** Сообщение в ветке карточки: события, вопросы, фото */
  noteToEditors(request: Request, text: string, attachment?: Attachment): Promise<void>;
  /** Личное сообщение сотруднику */
  sendToUser(telegramUserId: number, message: OutMessage): Promise<void>;
  /** Сообщение в тему «Сайт» (сводка) */
  postToOps(text: string): Promise<void>;
  /** Техническая тревога: сбои, которые нужно разобрать человеку */
  alert(text: string): Promise<void>;
}

export interface StoredPhoto {
  data: Uint8Array;
  mimeType: string;
}

/** Хранилище оригиналов фотографий (закрытая папка Drive). */
export interface PhotoStore {
  save(input: {
    personId: string;
    requestId: string;
    data: Uint8Array;
    mimeType: string;
    ext: string;
  }): Promise<string>;
  load(ref: string): Promise<StoredPhoto | undefined>;
}

/** Проверка публичного сайта: открывается ли страница. */
export interface SiteChecker {
  isSiteUrl(url: string): boolean;
  status(url: string): Promise<number>;
}

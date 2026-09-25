/**
 * Поля персональной страницы. Это единственное место, где они описаны:
 * отсюда строятся колонки листов Profiles и Requests, форма и карточка редактора.
 * Порядок совпадает с порядком блоков на странице сайта.
 */

export const FIELD_KEYS = ['title', 'about', 'projects', 'courses', 'contacts', 'channel'] as const;
export type FieldKey = (typeof FIELD_KEYS)[number];

export interface FieldDef {
  key: FieldKey;
  /** Заголовок колонки в таблице и подпись в форме */
  label: string;
  /** Подсказка под полем формы */
  hint: string;
  maxLength: number;
  multiline: boolean;
  requiredForCreate: boolean;
}

export const FIELDS: readonly FieldDef[] = [
  {
    key: 'title',
    label: 'Подпись',
    hint: 'Коротко, кто вы в центре: например, «преподавательница, исследовательница медиа».',
    maxLength: 200,
    multiline: false,
    requiredForCreate: true,
  },
  {
    key: 'about',
    label: 'О себе',
    hint: 'Два-три абзаца: чем занимаетесь, что вас интересует.',
    maxLength: 3000,
    multiline: true,
    requiredForCreate: true,
  },
  {
    key: 'projects',
    label: 'Проекты и исследования',
    hint: 'По строке на проект, со ссылками, если они есть.',
    maxLength: 3000,
    multiline: true,
    requiredForCreate: false,
  },
  {
    key: 'courses',
    label: 'Курсы',
    hint: 'Что вы ведёте в ИТМО.',
    maxLength: 3000,
    multiline: true,
    requiredForCreate: false,
  },
  {
    key: 'contacts',
    label: 'Контакты',
    hint: 'Только то, что можно публиковать: почта, Telegram, сайт.',
    maxLength: 2000,
    multiline: true,
    requiredForCreate: false,
  },
  {
    key: 'channel',
    label: 'Канал',
    hint: 'Ссылка на ваш канал, если хотите его указать.',
    maxLength: 300,
    multiline: false,
    requiredForCreate: false,
  },
];

export const FIELD_BY_KEY: Record<FieldKey, FieldDef> = Object.fromEntries(
  FIELDS.map((f) => [f.key, f]),
) as Record<FieldKey, FieldDef>;

export const PHOTO_LABEL = 'Фото';

export const PHOTO_RULES = {
  requiredForCreate: true,
  maxBytes: 20 * 1024 * 1024,
  /** Минимальная короткая сторона, px */
  minSide: 600,
  mimeTypes: ['image/jpeg', 'image/png', 'image/webp'] as readonly string[],
} as const;

export type ProfileFields = Partial<Record<FieldKey, string>>;

import { isUpcoming, TALK_FORMATS, TALK_PROCESS, talkAnnouncement, talkLine } from './talks.js';

/**
 * Процессы, с которыми бот помогает сотрудникам. Новый процесс — новая
 * запись здесь. Процессы одной группы падают в одну тему рабочего чата;
 * тему группы задаёт команда /setup в чате.
 */

/** Вопрос анкеты: бот задаёт их по очереди. */
export interface Question {
  key: string;
  /** Подпись поля в заявке для редактора */
  label: string;
  /** Вопрос сотруднику */
  ask: string;
  /** choice — кнопки с вариантами, но можно и написать свой */
  kind: 'text' | 'photo' | 'choice';
  options?: readonly string[];
  optional?: boolean;
  /** Подпись к фото в рабочем чате */
  caption?: string;
  /** Задавать, только если условие выполняется (по уже данным ответам) */
  when?: (answers: Answers, ctx: { now: Date; tz: string }) => boolean;
}

export type Answers = Record<string, string | undefined>;

export interface ProcessDef {
  id: string;
  group: string;
  /** Название в карточке заявки */
  title: string;
  /** Коротко — для сводки и списка заявок */
  short: string;
  /** Кнопка в меню */
  button: string;
  emoji: string;
  intro: string;
  /** Есть вопросы — бот ведёт по анкете; нет — принимает свободный текст */
  questions?: readonly Question[];
  /** Сообщение редактору под анкетой, например черновик строки для поста */
  note?: (userName: string, answers: Answers, ctx: { now: Date; tz: string }) => string | undefined;
}

/** Группы процессов и их темы в рабочем чате. */
export const GROUPS: Readonly<Record<string, string>> = {
  site: 'Страницы на сайте',
  talks: 'Выступления',
};

const upcoming = (a: Answers, { now, tz }: { now: Date; tz: string }) => isUpcoming(a, now, tz);

export const PROCESSES: readonly ProcessDef[] = [
  {
    id: 'site',
    group: 'site',
    title: 'Изменение страницы на сайте',
    short: 'изменение',
    button: 'Изменить мою страницу',
    emoji: '✏️',
    intro:
      'Напишите, что поменять на вашей странице: подпись, текст о себе, проекты, курсы, контакты. ' +
      'Можно несколькими сообщениями. Фото лучше отправить файлом, без сжатия.\n\n' +
      'Редактор увидит заявку, только когда вы нажмёте «Отправить заявку».',
  },
  {
    id: 'site_new',
    group: 'site',
    title: 'Новая страница на сайте',
    short: 'новая страница',
    button: 'Создать страницу на сайте',
    emoji: '🆕',
    intro:
      'Соберём всё для вашей страницы на сайте центра: семь коротких вопросов, необязательные можно пропустить. ' +
      'Если страница у вас уже есть, вернитесь в меню (/start) и выберите «Изменить мою страницу».',
    questions: [
      {
        key: 'name',
        label: 'Имя на сайте',
        ask: 'Как подписать вас на сайте? Имя и фамилия.',
        kind: 'text',
      },
      {
        key: 'title',
        label: 'Подпись',
        ask: 'Коротко, кто вы в центре. Например: «преподавательница, исследовательница медиа».',
        kind: 'text',
      },
      {
        key: 'about',
        label: 'О себе',
        ask: 'О себе: два-три абзаца — чем занимаетесь, что вас интересует.',
        kind: 'text',
      },
      {
        key: 'projects',
        label: 'Проекты и исследования',
        ask: 'Проекты и исследования: по строке на проект, со ссылками, если они есть.',
        kind: 'text',
        optional: true,
      },
      {
        key: 'courses',
        label: 'Курсы',
        ask: 'Какие курсы вы ведёте в ИТМО?',
        kind: 'text',
        optional: true,
      },
      {
        key: 'contacts',
        label: 'Контакты',
        ask: 'Контакты, которые можно опубликовать: почта, Telegram, сайт.',
        kind: 'text',
        optional: true,
      },
      {
        key: 'photo',
        label: 'Фото',
        ask: 'Фото для страницы. Лучше отправить файлом (скрепка → «Файл»), так оно не потеряет качество.',
        kind: 'photo',
        caption: 'Фото для страницы',
      },
    ],
  },
  {
    id: TALK_PROCESS,
    group: 'talks',
    title: 'Выступление',
    short: 'выступление',
    button: 'Рассказать о выступлении',
    emoji: '🎤',
    intro:
      'Расскажите о выступлении: докладе, лекции, дискуссии, интервью. Мы постараемся включить его ' +
      'в итоги месяца в канале центра. Если выступление не очень подходит каналу по теме, мы его не возьмём. ' +
      'Если выступление ещё впереди, тоже рассказывайте: возможно, сделаем анонс.',
    questions: [
      {
        key: 'event',
        label: 'Где',
        ask: 'Где? Напишите с предлогом, например: «на форуме «Радикальная стабильность» в ГЭС-2» или «в Шанинке».',
        kind: 'text',
      },
      {
        key: 'date',
        label: 'Когда',
        ask: 'Когда? Например: 15.10.2026.',
        kind: 'text',
      },
      {
        key: 'format',
        label: 'Формат',
        ask: 'Что это было? Выберите или напишите своё.',
        kind: 'choice',
        options: TALK_FORMATS,
      },
      {
        key: 'topic',
        label: 'Тема',
        ask: 'О чём? Название доклада или лекции, а если названия нет — пара слов о сути.',
        kind: 'text',
      },
      {
        key: 'about',
        label: 'О чём',
        ask: 'Выступление ещё впереди — сделаем анонс. В двух-трёх предложениях: о чём расскажете, кому будет интересно?',
        kind: 'text',
        when: upcoming,
      },
      {
        key: 'role',
        label: 'Как представить',
        ask: 'Как вас представить в анонсе? Например: «исследовательница, преподавательница DH-центра».',
        kind: 'text',
        optional: true,
        when: upcoming,
      },
      {
        key: 'time',
        label: 'Время',
        ask: 'Во сколько? Например: 19:00–20:30.',
        kind: 'text',
        optional: true,
        when: upcoming,
      },
      {
        key: 'place',
        label: 'Адрес',
        ask: 'Где именно: адрес и зал или «онлайн».',
        kind: 'text',
        optional: true,
        when: upcoming,
      },
      {
        key: 'reg',
        label: 'Регистрация',
        ask: 'Ссылка на регистрацию, если она нужна.',
        kind: 'text',
        optional: true,
        when: upcoming,
      },
      {
        key: 'with',
        label: 'Вместе с',
        ask: 'Выступали вместе с кем-то из коллег или студентов? Напишите имена.',
        kind: 'text',
        optional: true,
      },
      {
        key: 'link',
        label: 'Ссылка',
        ask: 'Ссылка на программу, анонс, пост организаторов или запись.',
        kind: 'text',
        optional: true,
      },
      {
        key: 'photo',
        label: 'Фото',
        ask: 'Фото с выступления, если есть.',
        kind: 'photo',
        optional: true,
        caption: 'Фото с выступления',
      },
    ],
    note: (name, a, { now, tz }) =>
      isUpcoming(a, now, tz)
        ? `📣 Черновик анонса:\n\n${talkAnnouncement(name, a, now, tz)}\n\nВ итоги месяца выступление тоже попадёт: /talks`
        : `📝 Черновик для итогов месяца:\n${talkLine(name, a)}`,
  },
];

export function processById(id: string): ProcessDef | undefined {
  return PROCESSES.find((p) => p.id === id);
}

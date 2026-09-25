/**
 * Процессы, с которыми бот помогает сотрудникам. Новый процесс — новая
 * запись здесь; тему, куда падают его заявки, задают командой /setup в чате.
 */
export interface ProcessDef {
  id: string;
  title: string;
  emoji: string;
  /** Что бот пишет, когда сотрудник выбрал процесс */
  intro: string;
}

export const PROCESSES: readonly ProcessDef[] = [
  {
    id: 'site',
    title: 'Страница на сайте',
    emoji: '🌐',
    intro:
      'Напишите, что поменять на вашей странице на сайте центра: подпись, текст о себе, проекты, курсы, контакты. ' +
      'Можно несколькими сообщениями. Фото лучше отправить файлом, без сжатия.\n\n' +
      'Когда всё отправите, нажмите «Отправить заявку».',
  },
];

export function processById(id: string): ProcessDef | undefined {
  return PROCESSES.find((p) => p.id === id);
}

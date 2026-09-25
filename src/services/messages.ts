import { FIELD_BY_KEY, type FieldKey, PHOTO_LABEL } from '../domain/fields.js';
import { REQUEST_TYPE_LABELS, type Request, STATUS_LABELS } from '../domain/model.js';
import type { OutMessage } from './ports.js';

/** Данные для кнопок заявителя в личке: c:<действие>:<заявка> */
export const requesterData = {
  confirm: (id: string) => `c:ok:${id}`,
  fix: (id: string) => `c:fix:${id}`,
  cancel: (id: string) => `c:cancel:${id}`,
};

export function changedLabels(r: Request): string[] {
  const labels = (Object.keys(r.fields) as FieldKey[]).map((k) => FIELD_BY_KEY[k].label);
  if (r.photo) labels.push(PHOTO_LABEL);
  return labels;
}

export function formInvite(r: Request, url: string): OutMessage {
  if (r.type === 'create') {
    return {
      text:
        'Готовим вашу страницу на сайте DH-центра. Заполните анкету: подпись, пару абзацев о себе и фото. ' +
        'Редактор получит её сразу после отправки.',
      buttons: [[{ text: 'Заполнить анкету', url }]],
    };
  }
  return {
    text:
      `Заявка ${r.requestId}. В форме — текущий текст вашей страницы: поправьте нужное и отправьте. ` +
      'Ссылка действует 14 дней.',
    buttons: [
      [{ text: 'Открыть форму', url }],
      [{ text: 'Отменить заявку', data: requesterData.cancel(r.requestId) }],
    ],
  };
}

export function needInfoMessage(r: Request, question: string, url: string): OutMessage {
  return {
    text:
      `Редактору нужно уточнение по заявке ${r.requestId}:\n«${question}»\n\n` +
      'Откройте анкету, поправьте и отправьте снова. Если нужно просто ответить, напишите ответ в поле «Комментарий редактору».',
    buttons: [[{ text: 'Открыть анкету', url }]],
  };
}

export function fixMessage(r: Request, url: string): OutMessage {
  return {
    text: `Исправьте текст в анкете и отправьте: редактор увидит изменения. Заявка ${r.requestId}.`,
    buttons: [[{ text: 'Открыть анкету', url }]],
  };
}

export function reminderMessage(r: Request, url: string): OutMessage {
  const what =
    r.status === 'needs_info'
      ? 'редактор ждёт от вас уточнения'
      : 'анкета для страницы на сайте ещё не заполнена';
  return {
    text: `Напоминание по заявке ${r.requestId}: ${what}.`,
    buttons: [[{ text: 'Открыть анкету', url }]],
  };
}

export function publishedMessage(r: Request, pageUrl: string | undefined, due: string): OutMessage {
  const what = r.type === 'create' ? 'Ваша страница опубликована' : 'Ваша страница обновлена';
  return {
    text:
      `${what}${pageUrl ? `: ${pageUrl}` : '.'}\n\n` +
      `Проверьте, всё ли верно. Если не ответите до ${due}, заявка ${r.requestId} закроется автоматически.`,
    buttons: [
      [
        { text: 'Всё верно', data: requesterData.confirm(r.requestId) },
        { text: 'Нужна правка', data: requesterData.fix(r.requestId) },
      ],
    ],
  };
}

export function reviewReminder(r: Request, pageUrl: string | undefined, due: string): OutMessage {
  return {
    text:
      `Напоминание: проверьте страницу${pageUrl ? ` ${pageUrl}` : ''}. ` +
      `После ${due} заявка ${r.requestId} закроется как подтверждённая.`,
    buttons: [
      [
        { text: 'Всё верно', data: requesterData.confirm(r.requestId) },
        { text: 'Нужна правка', data: requesterData.fix(r.requestId) },
      ],
    ],
  };
}

export function rejectedMessage(r: Request, reason: string): OutMessage {
  return { text: `Заявка ${r.requestId} отклонена редактором.\nПричина: ${reason}` };
}

export function autoConfirmedMessage(r: Request): OutMessage {
  return {
    text: `Заявка ${r.requestId} закрыта: вы не ответили, поэтому мы считаем публикацию подтверждённой. Если что-то не так, создайте новую заявку.`,
  };
}

export function statusLine(r: Request): string {
  return `${r.requestId} · ${REQUEST_TYPE_LABELS[r.type]} · ${STATUS_LABELS[r.status]}`;
}

export const HELP_TEXT =
  'Этот бот помогает обновлять персональные страницы на сайте DH-центра.\n\n' +
  '• «Обновить мою страницу» — открыть форму с текущим текстом и отправить правки редактору.\n' +
  '• «Мои заявки» — посмотреть, что с вашими заявками.\n' +
  '• «Снять мою страницу» — попросить убрать страницу с сайта.\n\n' +
  'Новые страницы создаются по решению администратора центра: бот сам пришлёт анкету.';

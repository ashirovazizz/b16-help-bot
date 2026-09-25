import { InlineKeyboard } from 'grammy';
import type { User } from 'grammy/types';
import { formatShortDate, zonedParts } from './core/time.js';
import { PROCESSES, type ProcessDef } from './processes.js';
import type { Binding, Status, Ticket } from './store.js';

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function displayName(u: Pick<User, 'id' | 'first_name' | 'last_name' | 'username'>): string {
  const full = [u.first_name, u.last_name].filter(Boolean).join(' ').trim();
  return full || (u.username ? `@${u.username}` : `id${u.id}`);
}

export const STATUS_LABELS: Record<Status, string> = {
  new: '🆕 новая',
  in_work: '🛠 в работе',
  done: '✅ готово',
  rejected: '⛔ отклонена',
};

export function when(iso: string, tz: string): string {
  const d = new Date(iso);
  const p = zonedParts(d, tz);
  return `${formatShortDate(d, tz)} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

/** Ссылка на сообщение в супергруппе: из дайджеста можно сразу перейти к карточке. */
export function messageLink(chatId: number, messageId: number): string | undefined {
  const s = String(chatId);
  return s.startsWith('-100') ? `https://t.me/c/${s.slice(4)}/${messageId}` : undefined;
}

export function thread(b: Binding): { message_thread_id?: number } {
  return b.threadId !== undefined ? { message_thread_id: b.threadId } : {};
}

/** Карточка заявки в рабочем чате (HTML). */
export function cardText(t: Ticket, p: ProcessDef, tz: string): string {
  const who = `<a href="tg://user?id=${t.userId}">${esc(t.userName)}</a>${
    t.username ? ` (@${esc(t.username)})` : ''
  }`;
  const lines = [
    `${p.emoji} <b>Заявка №${t.id}</b> · ${esc(p.title)}`,
    `От: ${who}`,
    `Статус: ${STATUS_LABELS[t.status]}${t.assigneeName ? ` · ${esc(t.assigneeName)}` : ''}`,
    `Создана: ${when(t.createdAt, tz)}`,
  ];
  if (t.closedAt && !(t.status === 'new' || t.status === 'in_work')) {
    lines.push(`Закрыта: ${when(t.closedAt, tz)}`);
  }
  if (t.status === 'new' || t.status === 'in_work') {
    lines.push(
      '',
      '<i>Ответьте на любое сообщение этой заявки — бот перешлёт ответ заявителю.</i>',
    );
  }
  return lines.join('\n');
}

export function cardKeyboard(t: Ticket): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (t.status === 'new') {
    kb.text('✋ Беру', `t:take:${t.id}`).text('✅ Готово', `t:done:${t.id}`).row();
    kb.text('⛔ Отклонить', `t:reject:${t.id}`);
  } else if (t.status === 'in_work') {
    kb.text('✅ Готово', `t:done:${t.id}`).text('⛔ Отклонить', `t:reject:${t.id}`);
  } else {
    kb.text('↩️ Вернуть в работу', `t:reopen:${t.id}`);
  }
  return kb;
}

export function menuKeyboard(configured: (processId: string) => boolean): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const p of PROCESSES) {
    if (configured(p.id)) kb.text(`${p.emoji} ${p.title}`, `p:${p.id}`).row();
  }
  return kb.text('📋 Мои заявки', 'm:list');
}

export const draftKeyboard = new InlineKeyboard()
  .text('📨 Отправить заявку', 'd:send')
  .text('✖️ Отменить', 'd:cancel');

export const HELP =
  'Я передаю ваши заявки в рабочий чат центра, а ответы оттуда — вам.\n\n' +
  'Выберите, с чем нужна помощь, опишите задачу одним или несколькими сообщениями и нажмите «Отправить заявку». ' +
  'Когда редактор ответит, сообщение придёт сюда; чтобы ответить, просто напишите в этот чат.';

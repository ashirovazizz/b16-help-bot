import { InlineKeyboard } from 'grammy';
import type { User } from 'grammy/types';
import { formatShortDate, zonedParts } from './core/time.js';
import { PROCESSES, type ProcessDef } from './processes.js';
import type { Answer, Binding, Status, Ticket } from './store.js';

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

/* ───── карточка в рабочем чате ───── */

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

const TEXT_CHUNK = 4000;

/** Ответы анкеты для редактора: подписанные поля, готовые к копированию (HTML, по частям ≤ 4000). */
export function answersText(p: ProcessDef, answers: Record<string, Answer>): string[] {
  const parts: string[] = [];
  for (const q of p.questions ?? []) {
    if (q.kind !== 'text') continue;
    const value = answers[q.key]?.text;
    const body = value ? esc(value) : '—';
    const part = `<b>${esc(q.label)}</b>\n${body}`;
    if (part.length <= TEXT_CHUNK) parts.push(part);
    else
      for (let i = 0; i < part.length; i += TEXT_CHUNK) parts.push(part.slice(i, i + TEXT_CHUNK));
  }
  const chunks: string[] = [];
  let current = '';
  for (const part of parts) {
    const next = current ? `${current}\n\n${part}` : part;
    if (next.length > TEXT_CHUNK && current) {
      chunks.push(current);
      current = part;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/* ───── личка сотрудника ───── */

export function menuKeyboard(available: (p: ProcessDef) => boolean): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const p of PROCESSES) {
    if (available(p)) kb.text(`${p.emoji} ${p.button}`, `p:${p.id}`).row();
  }
  return kb.text('📋 Мои заявки', 'm:list');
}

export const draftKeyboard = new InlineKeyboard()
  .text('📨 Отправить заявку', 'd:send')
  .text('✖️ Отменить', 'd:cancel');

export function questionKeyboard(optional: boolean): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (optional) kb.text('⏭ Пропустить', 'd:skip');
  return kb.text('✖️ Отменить', 'd:cancel');
}

export const summaryKeyboard = new InlineKeyboard()
  .text('📨 Отправить заявку', 'd:send')
  .row()
  .text('↩️ Заполнить заново', 'd:restart')
  .text('✖️ Отменить', 'd:cancel');

/** Итог анкеты для сотрудника перед отправкой. */
export function summaryText(p: ProcessDef, answers: Record<string, Answer>): string {
  const lines = ['Анкета заполнена:'];
  for (const q of p.questions ?? []) {
    const a = answers[q.key];
    let value: string;
    if (!a) value = '—';
    else if (q.kind === 'photo') value = '✓ есть';
    else {
      const text = (a.text ?? '').replace(/\s+/g, ' ').trim();
      value = text.length > 80 ? `${text.slice(0, 80)}…` : text;
    }
    lines.push(`• ${q.label}: ${value}`);
  }
  lines.push('', 'Всё верно? Нажмите «Отправить заявку».');
  return lines.join('\n');
}

export const HELP =
  'Я передаю ваши заявки в рабочий чат центра, а ответы оттуда — вам.\n\n' +
  'Выберите, что нужно сделать, опишите задачу и нажмите «Отправить заявку». ' +
  'Когда редактор ответит, сообщение придёт сюда; чтобы ответить, просто напишите в этот чат.';

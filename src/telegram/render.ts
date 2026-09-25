import { InlineKeyboard } from 'grammy';
import { REQUEST_TYPE_LABELS, type Request, STATUS_LABELS } from '../domain/model.js';
import { changedLabels } from '../services/messages.js';
import type { Button, CardView } from '../services/ports.js';

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const quote = (s: string, max = 300) => `«${s.length > max ? `${s.slice(0, max)}…` : s}»`;

/** Данные кнопок редактора в карточке: e:<действие>:<заявка> */
export const editorData = {
  take: (id: string) => `e:take:${id}`,
  info: (id: string) => `e:info:${id}`,
  publish: (id: string) => `e:pub:${id}`,
  reject: (id: string) => `e:rej:${id}`,
};

/** Текст карточки заявки для темы «Сайт» (HTML). */
export function renderCard(card: CardView): string {
  const r = card.request;
  const lines = [`<b>${esc(r.requestId)} · ${REQUEST_TYPE_LABELS[r.type]}</b>`, esc(r.fullName)];

  let status = `Статус: <b>${STATUS_LABELS[r.status].toLowerCase()}</b>`;
  if (card.dueLabel && r.status === 'with_editor') {
    status += card.overdue ? ` · срок ${card.dueLabel} ⚠️ просрочено` : ` · срок ${card.dueLabel}`;
  }
  if (card.dueLabel && r.status === 'review')
    status += ` · автоподтверждение после ${card.dueLabel}`;
  lines.push(status);

  if (r.assigneeName) lines.push(`Ведёт: ${esc(r.assigneeName)}`);
  if (r.type === 'archive') {
    lines.push(
      r.initiator === 'registry'
        ? 'Снять страницу по решению реестра.'
        : 'Человек сам просит снять страницу.',
    );
  } else {
    const changed = changedLabels(r);
    if (changed.length)
      lines.push(`${r.type === 'create' ? 'Заполнено' : 'Изменено'}: ${changed.join(', ')}`);
  }
  if (r.pageUrl) lines.push(`Страница: ${esc(r.pageUrl)}`);
  if (r.requesterNote) lines.push(`Комментарий заявителя: ${esc(quote(r.requesterNote))}`);
  if (r.editorNote && (r.status === 'needs_info' || r.status === 'rejected')) {
    lines.push(
      `${r.status === 'rejected' ? 'Причина отказа' : 'Вопрос заявителю'}: ${esc(quote(r.editorNote))}`,
    );
  }
  if (r.closeReason && (r.status === 'done' || r.status === 'cancelled')) {
    lines.push(`Итог: ${esc(r.closeReason)}`);
  }
  return lines.join('\n');
}

/** Кнопки карточки: действия доступны, пока заявка у редактора. */
export function cardKeyboard(card: CardView): InlineKeyboard {
  const r = card.request;
  const kb = new InlineKeyboard();
  if (r.status === 'with_editor') {
    if (r.assigneeId === undefined) kb.text('✋ Беру', editorData.take(r.requestId)).row();
    if (r.type === 'archive') {
      kb.text('✅ Снято с сайта', editorData.publish(r.requestId));
      if (r.initiator === 'person') kb.text('⛔ Отклонить', editorData.reject(r.requestId));
      kb.row();
    } else {
      kb.text('❓ Нужны данные', editorData.info(r.requestId))
        .text('✅ Опубликовано', editorData.publish(r.requestId))
        .row()
        .text('⛔ Отклонить', editorData.reject(r.requestId))
        .row();
    }
  }
  if (r.type !== 'archive') kb.url('📄 Открыть заявку', card.editorUrl);
  return kb;
}

export function keyboardOf(buttons: Button[][] | undefined): InlineKeyboard | undefined {
  if (!buttons?.length) return undefined;
  const kb = new InlineKeyboard();
  for (const row of buttons) {
    for (const b of row) {
      if ('url' in b) kb.url(b.text, b.url);
      else kb.text(b.text, b.data);
    }
    kb.row();
  }
  return kb;
}

export function requestLine(r: Request): string {
  return `${r.requestId} · ${REQUEST_TYPE_LABELS[r.type]} · ${STATUS_LABELS[r.status]}`;
}

/** Метки подсказок, на которые редактор отвечает текстом (ForceReply). */
export const PROMPTS = {
  needInfo: '❓ Вопрос заявителю по',
  pageUrl: '🔗 Адрес новой страницы для',
  reject: '⛔ Причина отказа по',
} as const;

export type PromptKind = keyof typeof PROMPTS;

export function parsePrompt(
  text: string | undefined,
): { kind: PromptKind; requestId: string } | undefined {
  if (!text) return undefined;
  const first = text.split('\n')[0] ?? '';
  for (const [kind, label] of Object.entries(PROMPTS) as [PromptKind, string][]) {
    if (first.startsWith(label)) {
      const m = /(R-\d+)/.exec(first.slice(label.length));
      if (m?.[1]) return { kind, requestId: m[1] };
    }
  }
  return undefined;
}

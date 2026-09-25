import { type Bot, type Context, InlineKeyboard } from 'grammy';
import type { User } from 'grammy/types';
import { isUserError } from '../core/errors.js';
import type { Logger } from '../core/logger.js';
import { STATUS_LABELS } from '../domain/model.js';
import type { Actor } from '../domain/workflow.js';
import { HELP_TEXT } from '../services/messages.js';
import type { OutMessage } from '../services/ports.js';
import type { RequestService, SyncReport } from '../services/service.js';
import { esc, keyboardOf, PROMPTS, type PromptKind, parsePrompt, requestLine } from './render.js';

export interface HandlerOptions {
  opsChatId: number;
  /** Куда сообщить о непредвиденной ошибке */
  alert?: (text: string) => Promise<void>;
}

export function displayName(u: User): string {
  const full = [u.first_name, u.last_name].filter(Boolean).join(' ').trim();
  return full || (u.username ? `@${u.username}` : `id${u.id}`);
}

export const MENU = new InlineKeyboard()
  .text('✏️ Обновить мою страницу', 'm:update')
  .row()
  .text('📋 Мои заявки', 'm:list')
  .row()
  .text('🗄 Снять мою страницу', 'm:archive');

const PROMPT_HINTS: Record<PromptKind, string> = {
  needInfo: 'напишите, что уточнить у заявителя',
  pageUrl: 'пришлите ссылку на опубликованную страницу',
  reject: 'напишите причину — её получит заявитель',
};

function inThread(ctx: Context) {
  const id = ctx.msg?.message_thread_id ?? ctx.callbackQuery?.message?.message_thread_id;
  return id !== undefined ? { message_thread_id: id } : {};
}

function syncSummary(r: SyncReport): string {
  const parts = [
    r.created.length && `новых страниц: ${r.created.length}`,
    r.archived.length && `на снятие: ${r.archived.length}`,
    r.withdrawn.length && `отозвано: ${r.withdrawn.length}`,
    r.invites.length && `новых приглашений: ${r.invites.length}`,
    r.assignedIds.length && `присвоено ID: ${r.assignedIds.length}`,
  ].filter(Boolean);
  const head = parts.length
    ? `Сверка с реестром: ${parts.join(', ')}.`
    : 'Сверка с реестром: изменений нет.';
  return r.problems.length ? `${head}\nПроверьте реестр:\n• ${r.problems.join('\n• ')}` : head;
}

/**
 * Обработчики бота. В личке — сотрудники (привязка, меню, подтверждения),
 * в рабочем чате — кнопки карточек и ответы редактора на подсказки.
 */
export function registerHandlers(
  bot: Bot,
  opts: HandlerOptions,
  service: RequestService,
  log: Logger,
): Bot {
  const isOps = (ctx: Context) => ctx.chat?.id === opts.opsChatId;

  const send = (ctx: Context, m: OutMessage) => {
    const reply_markup = keyboardOf(m.buttons);
    return ctx.reply(m.text, {
      ...(reply_markup ? { reply_markup } : {}),
      link_preview_options: { is_disabled: true },
    });
  };

  /** Понятные ошибки показываем человеку, остальные уходят в bot.catch. */
  const guard = async (ctx: Context, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      if (!isUserError(e)) throw e;
      if (ctx.callbackQuery) {
        await ctx.answerCallbackQuery({ text: e.message, show_alert: true }).catch(() => {});
      } else {
        await ctx.reply(e.message, inThread(ctx)).catch(() => {});
      }
    }
  };

  bot.catch(async (err) => {
    const ctx = err.ctx;
    log.error('Ошибка обработки сообщения', { updateId: ctx.update.update_id, error: err.error });
    await opts
      .alert?.(`⚠️ Ошибка бота (update ${ctx.update.update_id}): ${String(err.error)}`)
      .catch(() => {});
    const text = 'Что-то пошло не так. Мы уже разбираемся — попробуйте чуть позже.';
    if (ctx.callbackQuery)
      await ctx.answerCallbackQuery({ text, show_alert: true }).catch(() => {});
    else if (ctx.chat?.type === 'private') await ctx.reply(text).catch(() => {});
  });

  /* ───── любые чаты ───── */

  // /id — узнать ID чата и темы при настройке (в группе: /id@имя_бота)
  bot.command('id', async (ctx) => {
    const lines = [`chat_id: ${ctx.chat.id}`];
    if (ctx.msg.message_thread_id !== undefined)
      lines.push(`topic_id: ${ctx.msg.message_thread_id}`);
    if (ctx.chat.type === 'private') lines.push(`ваш Telegram ID: ${ctx.from?.id}`);
    await ctx.reply(lines.join('\n'), inThread(ctx));
  });

  /* ───── личка ───── */

  const priv = bot.chatType('private');

  const greet = async (ctx: Context & { from: User }) => {
    try {
      const person = await service.identify(ctx.from.id);
      await ctx.reply(`Здравствуйте, ${person.fullName}!\n\n${HELP_TEXT}`, { reply_markup: MENU });
    } catch (e) {
      if (!isUserError(e)) throw e;
      await ctx.reply(`${e.message}\n\n${HELP_TEXT}`);
    }
  };

  priv.command('start', (ctx) =>
    guard(ctx, async () => {
      const code = ctx.match.trim();
      if (!code) return greet(ctx);
      const res = await service.bind(code, {
        id: ctx.from.id,
        name: displayName(ctx.from),
        ...(ctx.from.username ? { username: ctx.from.username } : {}),
      });
      await ctx.reply(
        res.alreadyBound
          ? `Вы уже подключены, ${res.person.fullName}.`
          : `Готово, ${res.person.fullName}: бот вас узнал.\n\n${HELP_TEXT}`,
        { reply_markup: MENU },
      );
      if (res.pending) await send(ctx, res.pending.message);
    }),
  );

  priv.command(['menu', 'help'], (ctx) => guard(ctx, () => greet(ctx)));

  priv.callbackQuery('m:update', (ctx) =>
    guard(ctx, async () => {
      const res = await service.startUpdate(ctx.from.id);
      await ctx.answerCallbackQuery();
      if (res.kind === 'waiting') {
        await ctx.reply(
          `Заявка ${res.request.requestId} сейчас «${STATUS_LABELS[res.request.status]}». Бот напишет, когда понадобится ваше участие.`,
        );
      } else {
        await send(ctx, res.message);
      }
    }),
  );

  priv.callbackQuery('m:list', (ctx) =>
    guard(ctx, async () => {
      const list = await service.myRequests(ctx.from.id);
      await ctx.answerCallbackQuery();
      await ctx.reply(list.length ? list.map(requestLine).join('\n') : 'Заявок пока нет.');
    }),
  );

  priv.callbackQuery('m:archive', (ctx) =>
    guard(ctx, async () => {
      await service.identify(ctx.from.id);
      await ctx.answerCallbackQuery();
      await ctx.reply(
        'Снять вашу страницу с сайта? Текст и история сохранятся, страницу можно будет вернуть.',
        {
          reply_markup: new InlineKeyboard()
            .text('Да, снять страницу', 'm:archive:yes')
            .text('Нет', 'm:close'),
        },
      );
    }),
  );

  priv.callbackQuery('m:archive:yes', (ctx) =>
    guard(ctx, async () => {
      const r = await service.requestArchive(ctx.from.id);
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(`Заявка ${r.requestId} на снятие страницы отправлена редактору.`);
    }),
  );

  priv.callbackQuery('m:close', async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText('Хорошо, ничего не меняем.').catch(() => {});
  });

  priv.callbackQuery(/^c:(ok|fix|cancel):(R-\d+)$/, (ctx) =>
    guard(ctx, async () => {
      const action = ctx.match[1];
      const id = ctx.match[2]!;
      if (action === 'ok') {
        await service.confirm(ctx.from.id, id);
        await ctx.answerCallbackQuery({ text: 'Спасибо!' });
        await ctx.editMessageReplyMarkup().catch(() => {});
        await ctx.reply(`Заявка ${id} закрыта. Спасибо!`);
      } else if (action === 'fix') {
        const res = await service.askFix(ctx.from.id, id);
        await ctx.answerCallbackQuery();
        await ctx.editMessageReplyMarkup().catch(() => {});
        await send(ctx, res.message);
      } else {
        await service.cancel(ctx.from.id, id);
        await ctx.answerCallbackQuery({ text: 'Заявка отменена' });
        await ctx.editMessageReplyMarkup().catch(() => {});
        await ctx.reply(`Заявка ${id} отменена.`);
      }
    }),
  );

  // Свободный текст в личке бот не разбирает — показывает меню
  priv.on('message', (ctx) =>
    ctx.reply('Я понимаю только кнопки. Выберите, что сделать:', { reply_markup: MENU }),
  );

  /* ───── рабочий чат: карточки ───── */

  const editorOf = (u: User): Actor => ({ kind: 'editor', id: u.id, name: displayName(u) });

  const prompt = async (ctx: Context & { from: User }, kind: PromptKind, requestId: string) => {
    const who = `<a href="tg://user?id=${ctx.from.id}">${esc(displayName(ctx.from))}</a>`;
    const cardId = ctx.callbackQuery?.message?.message_id;
    await ctx.api.sendMessage(
      opts.opsChatId,
      `${PROMPTS[kind]} ${requestId}\n${who}, ${PROMPT_HINTS[kind]} — ответом на это сообщение.`,
      {
        parse_mode: 'HTML',
        ...inThread(ctx),
        reply_markup: { force_reply: true, selective: true },
        ...(cardId !== undefined
          ? { reply_parameters: { message_id: cardId, allow_sending_without_reply: true } }
          : {}),
      },
    );
  };

  bot.callbackQuery(/^e:(take|info|pub|rej):(R-\d+)$/, (ctx) =>
    guard(ctx, async () => {
      if (!isOps(ctx)) {
        await ctx.answerCallbackQuery();
        return;
      }
      const action = ctx.match[1];
      const id = ctx.match[2]!;
      const editor = editorOf(ctx.from);
      if (action === 'take') {
        await service.take(id, editor);
        await ctx.answerCallbackQuery({ text: 'Заявка закреплена за вами' });
      } else if (action === 'info') {
        await service.checkEditor(id, 'needInfo', editor);
        await prompt(ctx, 'needInfo', id);
        await ctx.answerCallbackQuery();
      } else if (action === 'rej') {
        await service.checkEditor(id, 'reject', editor);
        await prompt(ctx, 'reject', id);
        await ctx.answerCallbackQuery();
      } else {
        const res = await service.publish(id, editor);
        if (res.kind === 'needUrl') {
          await prompt(ctx, 'pageUrl', id);
          await ctx.answerCallbackQuery();
        } else {
          await ctx.answerCallbackQuery(
            res.warning
              ? { text: `Отмечено. ${res.warning}`, show_alert: true }
              : { text: 'Отмечено' },
          );
        }
      }
    }),
  );

  // Ответы редактора на подсказки (ForceReply)
  bot.on('message:text', async (ctx, next) => {
    const replyTo = ctx.msg.reply_to_message;
    if (!isOps(ctx) || !replyTo || replyTo.from?.id !== ctx.me.id) return next();
    const parsed = parsePrompt(replyTo.text);
    if (!parsed) return next();
    await guard(ctx, async () => {
      const editor = editorOf(ctx.from);
      const text = ctx.msg.text.trim();
      const answer = { ...inThread(ctx), reply_parameters: { message_id: ctx.msg.message_id } };
      if (parsed.kind === 'needInfo') {
        await service.needInfo(parsed.requestId, editor, text);
        await ctx.reply(`Вопрос по ${parsed.requestId} отправлен заявителю.`, answer);
      } else if (parsed.kind === 'reject') {
        await service.reject(parsed.requestId, editor, text);
        await ctx.reply(`Заявка ${parsed.requestId} отклонена, заявитель получил причину.`, answer);
      } else {
        const url = /https?:\/\/\S+/.exec(text)?.[0];
        if (!url) {
          await ctx.reply('Пришлите ссылку целиком, начиная с https://', answer);
          return;
        }
        const res = await service.publish(parsed.requestId, editor, url);
        const warning = res.kind === 'done' && res.warning ? `\n⚠️ ${res.warning}` : '';
        await ctx.reply(
          `Заявка ${parsed.requestId} отмечена как опубликованная.${warning}`,
          answer,
        );
      }
      await ctx.api.deleteMessage(opts.opsChatId, replyTo.message_id).catch(() => {});
    });
  });

  // /sync — сверить реестр сразу, не дожидаясь таймера (в группе: /sync@имя_бота)
  bot.command('sync', async (ctx) => {
    if (!isOps(ctx)) return;
    await guard(ctx, async () => {
      const report = await service.syncRegistry();
      await ctx.reply(syncSummary(report), inThread(ctx));
    });
  });

  return bot;
}

import type { Bot, Context } from 'grammy';
import { isUserError } from './core/errors.js';
import type { Logger } from './core/logger.js';
import type { Desk, EditorAction } from './desk.js';

export interface HandlerOptions {
  /** Куда сообщить о непредвиденной ошибке */
  alert?: (text: string) => Promise<void>;
}

const NOT_CONFIGURED =
  'Бот ещё не настроен: администратору нужно выбрать тему для заявок командой /setup в рабочем чате.';

function inThread(ctx: Context) {
  const id = ctx.msg?.message_thread_id;
  return id !== undefined ? { message_thread_id: id } : {};
}

/**
 * Обработчики. В личке — сотрудник: меню, черновик, отправка, ответы.
 * В рабочем чате — кнопки карточек и ответы редактора на сообщения заявок.
 */
export function registerHandlers(
  bot: Bot,
  desk: Desk,
  log: Logger,
  opts: HandlerOptions = {},
): Bot {
  const guard = async (ctx: Context, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      if (!isUserError(e)) throw e;
      if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: e.message, show_alert: true });
      else await ctx.reply(e.message, inThread(ctx));
    }
  };

  bot.catch(async (err) => {
    const ctx = err.ctx;
    log.error('Ошибка обработки сообщения', { updateId: ctx.update.update_id, error: err.error });
    await opts.alert?.(`⚠️ Ошибка бота: ${String(err.error)}`).catch(() => {});
    const text = 'Что-то пошло не так. Попробуйте ещё раз чуть позже.';
    if (ctx.callbackQuery)
      await ctx.answerCallbackQuery({ text, show_alert: true }).catch(() => {});
    else if (ctx.chat?.type === 'private') await ctx.reply(text).catch(() => {});
  });

  /* ───── любые чаты ───── */

  bot.command('id', async (ctx) => {
    const lines = [`chat_id: ${ctx.chat.id}`];
    if (ctx.msg.message_thread_id !== undefined)
      lines.push(`topic_id: ${ctx.msg.message_thread_id}`);
    if (ctx.chat.type === 'private') lines.push(`ваш Telegram ID: ${ctx.from?.id}`);
    await ctx.reply(lines.join('\n'), inThread(ctx));
  });

  bot.command('setup', async (ctx) => {
    const args = ctx.match.trim().split(/\s+/).filter(Boolean);
    await ctx.reply(await desk.setup(ctx.msg, args), inThread(ctx));
  });

  // Бота добавили в группу — подсказываем, как выбрать тему для заявок
  bot.on('my_chat_member', async (ctx) => {
    const { chat, new_chat_member: m, old_chat_member: old } = ctx.myChatMember;
    if (chat.type === 'private' || desk.isOpsChat(chat.id)) return;
    const joined =
      (m.status === 'member' || m.status === 'administrator') &&
      (old.status === 'left' || old.status === 'kicked');
    if (!joined) return;
    await ctx.api
      .sendMessage(
        chat.id,
        `Привет! Чтобы заявки приходили сюда, отправьте в нужной теме:\n/setup@${ctx.me.username} КОД\nКод показал установщик на сервере.`,
      )
      .catch(() => {});
  });

  /* ───── личка ───── */

  const priv = bot.chatType('private');

  const allowed = async (ctx: Context & { from: { id: number } }) => {
    if (!desk.configured) {
      await ctx.reply(NOT_CONFIGURED);
      return false;
    }
    return true;
  };

  priv.command(['start', 'menu', 'help'], async (ctx) => {
    if (!(await allowed(ctx))) return;
    await desk.menu(ctx.chat.id, `Здравствуйте, ${ctx.from.first_name}!`);
  });

  priv.callbackQuery(/^p:([a-z_]+)$/, (ctx) =>
    guard(ctx, async () => {
      await ctx.answerCallbackQuery();
      if (!(await allowed(ctx))) return;
      await desk.startDraft(ctx.from, ctx.match[1]!);
    }),
  );

  priv.callbackQuery('d:send', (ctx) =>
    guard(ctx, async () => {
      if (!(await allowed(ctx))) return void (await ctx.answerCallbackQuery());
      const t = await desk.submit(ctx.from);
      await ctx.answerCallbackQuery({ text: `Заявка №${t.id} отправлена` });
    }),
  );

  priv.callbackQuery('d:skip', (ctx) =>
    guard(ctx, async () => {
      await desk.skip(ctx.from.id);
      await ctx.answerCallbackQuery();
    }),
  );

  priv.callbackQuery('d:restart', (ctx) =>
    guard(ctx, async () => {
      await desk.restart(ctx.from.id);
      await ctx.answerCallbackQuery();
    }),
  );

  priv.callbackQuery('d:cancel', async (ctx) => {
    await desk.cancelDraft(ctx.from.id);
    await ctx.answerCallbackQuery({ text: 'Отменено' });
  });

  priv.callbackQuery('m:list', async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply(desk.myTickets(ctx.from.id));
  });

  // Любое сообщение: ответ по заявке, часть черновика или меню
  priv.on('message', async (ctx) => {
    if (!(await allowed(ctx))) return;
    if (!desk.isTicketReply(ctx.msg) && desk.hasDraft(ctx.from.id)) {
      await desk.addToDraft(ctx.msg);
      return;
    }
    const t = await desk.relayFromUser(ctx.msg);
    if (!t) await desk.menu(ctx.chat.id);
  });

  /* ───── рабочий чат ───── */

  bot.callbackQuery(/^t:(take|done|reject|reopen):(\d+)$/, async (ctx) => {
    const chatId = ctx.callbackQuery.message?.chat.id;
    if (chatId === undefined || !desk.isOpsChat(chatId)) {
      await ctx.answerCallbackQuery();
      return;
    }
    const text = await desk.act(
      Number(ctx.match[2]),
      ctx.match[1] as EditorAction,
      ctx.from,
      chatId,
    );
    await ctx.answerCallbackQuery({ text });
  });

  // Ответ редактора на сообщение заявки — заявителю
  bot.on('message', async (ctx, next) => {
    if (ctx.chat.type === 'private' || !desk.isOpsChat(ctx.chat.id)) return next();
    if (!(await desk.relayFromOps(ctx.msg))) return next();
  });

  return bot;
}

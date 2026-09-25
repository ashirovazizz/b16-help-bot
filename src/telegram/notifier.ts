import { type Api, GrammyError, InputFile } from 'grammy';
import type { Request } from '../domain/model.js';
import type { Attachment, CardView, Notifier, OutMessage } from '../services/ports.js';
import { cardKeyboard, keyboardOf, renderCard } from './render.js';

export interface ChatTarget {
  chatId: number;
  topicId?: number;
}

const thread = (t: ChatTarget) => (t.topicId !== undefined ? { message_thread_id: t.topicId } : {});

function isGrammy(e: unknown, fragment: string): boolean {
  return e instanceof GrammyError && e.description.includes(fragment);
}

/** Сообщения бота: карточки в теме «Сайт», личные сообщения, сводка, тревоги. */
export class TelegramNotifier implements Notifier {
  constructor(
    private readonly api: Api,
    private readonly ops: ChatTarget,
    private readonly alerts: ChatTarget = ops,
  ) {}

  async upsertCard(card: CardView): Promise<number | undefined> {
    const text = renderCard(card);
    const reply_markup = cardKeyboard(card);
    const common = {
      parse_mode: 'HTML' as const,
      reply_markup,
      link_preview_options: { is_disabled: true },
    };
    const existing = card.request.cardMessageId;
    if (existing !== undefined) {
      try {
        await this.api.editMessageText(this.ops.chatId, existing, text, common);
        return existing;
      } catch (e) {
        if (isGrammy(e, 'message is not modified')) return existing;
        if (!isGrammy(e, 'message to edit not found')) throw e;
        // карточку удалили руками — присылаем новую
      }
    }
    const msg = await this.api.sendMessage(this.ops.chatId, text, {
      ...common,
      ...thread(this.ops),
    });
    return msg.message_id;
  }

  async noteToEditors(request: Request, text: string, attachment?: Attachment): Promise<void> {
    const reply = request.cardMessageId
      ? {
          reply_parameters: {
            message_id: request.cardMessageId,
            allow_sending_without_reply: true,
          },
        }
      : {};
    if (attachment) {
      await this.api.sendDocument(
        this.ops.chatId,
        new InputFile(attachment.data, attachment.filename),
        { caption: text, ...reply, ...thread(this.ops) },
      );
      return;
    }
    await this.api.sendMessage(this.ops.chatId, text, {
      ...reply,
      ...thread(this.ops),
      link_preview_options: { is_disabled: true },
    });
  }

  async sendToUser(telegramUserId: number, message: OutMessage): Promise<void> {
    const reply_markup = keyboardOf(message.buttons);
    await this.api.sendMessage(telegramUserId, message.text, {
      ...(reply_markup ? { reply_markup } : {}),
      link_preview_options: { is_disabled: true },
    });
  }

  async postToOps(text: string): Promise<void> {
    await this.api.sendMessage(this.ops.chatId, text, {
      ...thread(this.ops),
      link_preview_options: { is_disabled: true },
    });
  }

  async alert(text: string): Promise<void> {
    await this.api.sendMessage(this.alerts.chatId, text.slice(0, 4000), thread(this.alerts));
  }
}

import {
  splitTelegramText,
  TelegramApiError,
  type TelegramClient,
  type TelegramInlineButton,
  type TelegramSentMessage,
} from './telegramClient';

/**
 * Every send to Telegram goes through one queue per bot: sends are one at a time and spaced out,
 * which keeps a busy minute (a brief, a reply in several pieces, a row of reminders) inside
 * Telegram's limits. A send is never retried when it may already have gone out: only a refusal
 * Telegram answered (a 4xx, including a 429 that names a wait) proves nothing was delivered, and
 * only that is retried, once, after the wait Telegram named. A send with no answer is reported
 * as failed and left alone, so the person never gets the same message twice.
 */

/** The gap kept between two sends to the same bot. Telegram allows about one message a second to one chat. */
export const TELEGRAM_SEND_GAP_MS = 1100;

export interface TelegramSendQueue {
  /** Runs one send after the sends queued before it, spaced by the gap. */
  enqueue<T>(send: () => Promise<T>): Promise<T>;
}

export function createTelegramSendQueue({
  gapMs = TELEGRAM_SEND_GAP_MS,
  now = () => Date.now(),
  sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
}: {
  gapMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
} = {}): TelegramSendQueue {
  let tail: Promise<void> = Promise.resolve();
  let lastSentAt = 0;

  return {
    enqueue<T>(send: () => Promise<T>): Promise<T> {
      const run = async (): Promise<T> => {
        const wait = lastSentAt + gapMs - now();
        if (wait > 0) {
          await sleep(wait);
        }
        try {
          return await send();
        } finally {
          lastSentAt = now();
        }
      };
      const result = tail.then(run);
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
}

/**
 * Sends one text through the queue, split into as many messages as its length needs. The buttons,
 * when given, ride the last piece. Resolves to the last piece's message. Throws the send's
 * TelegramApiError when a piece fails; pieces already sent are not resent.
 */
export async function sendTelegramText(input: {
  queue: TelegramSendQueue;
  client: TelegramClient;
  chat_id: string;
  text: string;
  inline_buttons?: readonly (readonly TelegramInlineButton[])[] | undefined;
  sleep?: (ms: number) => Promise<void>;
}): Promise<TelegramSentMessage> {
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const parts = splitTelegramText(input.text);
  let sent: TelegramSentMessage | undefined;
  for (const [index, part] of parts.entries()) {
    const isLast = index === parts.length - 1;
    sent = await input.queue.enqueue(async () => {
      try {
        return await input.client.sendMessage({
          chat_id: input.chat_id,
          text: part,
          inline_buttons: isLast ? input.inline_buttons : undefined,
        });
      } catch (error) {
        // Only a refusal proves nothing went out. A 429 names its wait; any other refusal is
        // retried once after a short wait. No answer at all means the message may be delivered
        // already, so it is never sent twice.
        if (!(error instanceof TelegramApiError) || !error.refused) {
          throw error;
        }
        await sleep(error.retryAfterSeconds === null ? 1000 : error.retryAfterSeconds * 1000);
        return input.client.sendMessage({
          chat_id: input.chat_id,
          text: part,
          inline_buttons: isLast ? input.inline_buttons : undefined,
        });
      }
    });
  }
  if (sent === undefined) {
    throw new TelegramApiError({ message: 'Nothing was sent.', errorCode: null });
  }
  return sent;
}

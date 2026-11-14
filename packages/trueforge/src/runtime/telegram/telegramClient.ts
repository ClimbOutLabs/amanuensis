import { z } from 'zod';

import { TelegramUpdateSchema, type TelegramUpdate } from '../../schemas/telegram';

/**
 * The Telegram Bot API, over plain fetch. One client per bot token. The token is part of every
 * request address, so it is never put in an error, a log line or a result: failures carry only
 * Telegram's own error code and description. Tests point the client at a fake API through the
 * base address and fetch seams.
 */

export const TELEGRAM_API_BASE_URL = 'https://api.telegram.org';

/** The longest text one Telegram message can carry. */
export const TELEGRAM_MAX_MESSAGE_CHARS = 4096;

const REQUEST_TIMEOUT_MS = 15_000;
/** A long poll waits a little less than this on Telegram's side, so the caller's own deadline is never the one that fires first. */
export const TELEGRAM_POLL_TIMEOUT_SECONDS = 25;

export interface TelegramBotInfo {
  id: string;
  name: string;
  username: string | null;
}

export interface TelegramInlineButton {
  text: string;
  callback_data: string;
}

export interface TelegramSentMessage {
  message_id: number;
}

/** A failure Telegram answered, or one where no answer came back at all. */
export class TelegramApiError extends Error {
  readonly errorCode: number | null;
  /** Seconds Telegram asked us to wait, on a 429; null when it did not say. */
  readonly retryAfterSeconds: number | null;
  /** True when Telegram refused the call (a 4xx answer), so the message was certainly not sent. */
  readonly refused: boolean;

  constructor(input: {
    message: string;
    errorCode: number | null;
    retryAfterSeconds?: number | null;
    refused?: boolean;
    cause?: unknown;
  }) {
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause });
    this.name = 'TelegramApiError';
    this.errorCode = input.errorCode;
    this.retryAfterSeconds = input.retryAfterSeconds ?? null;
    this.refused = input.refused ?? false;
  }
}

const TelegramFileSchema = z.object({ file_path: z.string().min(1) });

const GetMeResultSchema = z.object({
  id: z.number().int(),
  first_name: z.string(),
  username: z.string().optional(),
});

const SentMessageSchema = z.object({ message_id: z.number().int() });

const RawUpdateIdSchema = z.object({ update_id: z.number().int() });

/** The id of one raw update, read on its own; null when the raw value does not carry one. */
function rawUpdateId(item: unknown): number | null {
  const parsed = RawUpdateIdSchema.safeParse(item);
  return parsed.success ? parsed.data.update_id : null;
}

/** The envelope every Bot API answer arrives in: ok, the result when it worked, and why not when it did not. */
const TelegramEnvelopeSchema = z.object({
  ok: z.boolean(),
  result: z.unknown().optional(),
  description: z.string().optional(),
  error_code: z.number().optional(),
  parameters: z.object({ retry_after: z.number().optional() }).optional(),
});

export interface TelegramClient {
  /** Who the token belongs to. Throws a TelegramApiError when Telegram refuses the token. */
  getMe(): Promise<TelegramBotInfo>;
  /**
   * Long polling: asks for updates after `offset` and waits up to the poll timeout for some.
   * The caller advances its stored offset only for updates it has handed over. An update that
   * arrives in a shape that cannot be read is skipped, never allowed to hold the rest of the
   * batch hostage: `onSkippedUpdate` hears about each one, and when its id can still be read it
   * comes back as a bare update, so the caller's offset moves past it like any other.
   */
  getUpdates(input: {
    offset: string | null;
    signal?: AbortSignal;
    onSkippedUpdate?: (skipped: { update_id: number | null }) => void;
  }): Promise<TelegramUpdate[]>;
  /** Sends one message. Throws a TelegramApiError on any failure; the caller decides what is safe to retry. */
  sendMessage(input: {
    chat_id: string;
    text: string;
    inline_buttons?: readonly (readonly TelegramInlineButton[])[] | undefined;
  }): Promise<TelegramSentMessage>;
  /** Stops the spinner on a tapped button. A failure here is worth logging, never retrying blindly. */
  answerCallbackQuery(input: { callback_query_id: string; text?: string | undefined }): Promise<void>;
  /** Fetches a file the person sent, as bytes. Throws a TelegramApiError when it cannot be read. */
  downloadFile(input: { file_id: string }): Promise<Uint8Array>;
  /** Points Telegram at this instance's webhook address, with the secret it must send back. */
  setWebhook(input: { url: string; secret_token: string }): Promise<void>;
  /** Stops webhook delivery, back to polling. */
  deleteWebhook(): Promise<void>;
}

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

export function createTelegramClient({
  token,
  fetchImpl = (input, init) => fetch(input, init),
  baseUrl = TELEGRAM_API_BASE_URL,
}: {
  token: string;
  fetchImpl?: FetchImpl;
  baseUrl?: string;
}): TelegramClient {
  const botBase = `${baseUrl.replace(/\/+$/, '')}/bot${token}`;
  const fileBase = `${baseUrl.replace(/\/+$/, '')}/file/bot${token}`;

  async function call<T>(input: {
    method: string;
    body?: unknown;
    result: z.ZodType<T>;
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<T> {
    let response: Response;
    try {
      response = await fetchImpl(`${botBase}/${input.method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input.body ?? {}),
        signal: input.signal ?? AbortSignal.timeout(input.timeoutMs ?? REQUEST_TIMEOUT_MS),
      });
    } catch (cause) {
      // No answer came back. What that means depends on the call, so the error says only this.
      throw new TelegramApiError({
        message: 'Telegram could not be reached.',
        errorCode: null,
        cause,
      });
    }
    const payload: unknown = await response.json().catch(() => undefined);
    const envelope = TelegramEnvelopeSchema.safeParse(payload);
    if (!response.ok || !envelope.success || !envelope.data.ok) {
      const description = envelope.success ? envelope.data.description : undefined;
      const errorCode = envelope.success ? envelope.data.error_code : undefined;
      const retryAfter = envelope.success ? envelope.data.parameters?.retry_after : undefined;
      throw new TelegramApiError({
        message:
          description !== undefined && description !== ''
            ? `Telegram said: ${description}`
            : 'Telegram refused the call.',
        errorCode: errorCode ?? response.status,
        retryAfterSeconds: retryAfter ?? null,
        refused: response.status >= 400 && response.status < 500,
      });
    }
    const parsed = input.result.safeParse(envelope.data.result);
    if (!parsed.success) {
      throw new TelegramApiError({
        message: 'Telegram answered in a way that could not be read.',
        errorCode: null,
        cause: parsed.error,
      });
    }
    return parsed.data;
  }

  return {
    async getMe() {
      const me = await call({ method: 'getMe', result: GetMeResultSchema });
      return { id: String(me.id), name: me.first_name, username: me.username ?? null };
    },

    async getUpdates({ offset, signal, onSkippedUpdate }) {
      const raw = await call({
        method: 'getUpdates',
        body: {
          ...(offset === null ? {} : { offset: Number(offset) }),
          timeout: TELEGRAM_POLL_TIMEOUT_SECONDS,
          allowed_updates: ['message', 'callback_query'],
        },
        result: z.array(z.unknown()),
        ...(signal === undefined ? {} : { signal }),
        timeoutMs: (TELEGRAM_POLL_TIMEOUT_SECONDS + 10) * 1000,
      });
      const updates: TelegramUpdate[] = [];
      for (const item of raw) {
        const parsed = TelegramUpdateSchema.safeParse(item);
        if (parsed.success) {
          updates.push(parsed.data);
          continue;
        }
        // Telegram adds message kinds over time, and one update in a shape this build cannot
        // read must not stall the batch behind it: it is skipped, and when its id can still be
        // read it travels as a bare update so the stored offset moves past it.
        const skippedId = rawUpdateId(item);
        onSkippedUpdate?.({ update_id: skippedId });
        if (skippedId !== null) {
          updates.push({ update_id: skippedId });
        }
      }
      return updates;
    },

    async sendMessage({ chat_id, text, inline_buttons }) {
      return call({
        method: 'sendMessage',
        body: {
          chat_id: Number(chat_id),
          text,
          ...(inline_buttons === undefined
            ? {}
            : {
                reply_markup: {
                  inline_keyboard: inline_buttons.map(row => row.map(button => ({ ...button }))),
                },
              }),
        },
        result: SentMessageSchema,
      });
    },

    async answerCallbackQuery({ callback_query_id, text }) {
      await call({
        method: 'answerCallbackQuery',
        body: { callback_query_id, ...(text === undefined ? {} : { text }) },
        result: z.boolean(),
      });
    },

    async downloadFile({ file_id }) {
      const file = await call({ method: 'getFile', body: { file_id }, result: TelegramFileSchema });
      let response: Response;
      try {
        response = await fetchImpl(`${fileBase}/${file.file_path}`, {
          method: 'GET',
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (cause) {
        throw new TelegramApiError({
          message: 'The file could not be downloaded from Telegram.',
          errorCode: null,
          cause,
        });
      }
      if (!response.ok) {
        throw new TelegramApiError({
          message: 'The file could not be downloaded from Telegram.',
          errorCode: response.status,
          refused: response.status >= 400 && response.status < 500,
        });
      }
      return new Uint8Array(await response.arrayBuffer());
    },

    async setWebhook({ url, secret_token }) {
      // One connection is enough: this instance is the only reader of its webhook, and a
      // single connection keeps updates arriving one at a time instead of in parallel.
      await call({
        method: 'setWebhook',
        body: { url, secret_token, max_connections: 1, allowed_updates: ['message', 'callback_query'] },
        result: z.boolean(),
      });
    },

    async deleteWebhook() {
      await call({ method: 'deleteWebhook', body: {}, result: z.boolean() });
    },
  };
}

/**
 * Splits a long text into message-sized pieces, on line breaks where it can. A hard cut never
 * lands inside a surrogate pair: a piece ending on half an emoji is text Telegram refuses,
 * which used to lose that piece and every piece after it.
 */
export function splitTelegramText(text: string): string[] {
  if (text.length <= TELEGRAM_MAX_MESSAGE_CHARS) {
    return [text];
  }
  const parts: string[] = [];
  let rest = text;
  while (rest.length > TELEGRAM_MAX_MESSAGE_CHARS) {
    const window = rest.slice(0, TELEGRAM_MAX_MESSAGE_CHARS);
    const breakAt = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('\n'), window.lastIndexOf(' '));
    let cut = breakAt > TELEGRAM_MAX_MESSAGE_CHARS / 2 ? breakAt : TELEGRAM_MAX_MESSAGE_CHARS;
    const before = rest.charCodeAt(cut - 1);
    const after = rest.charCodeAt(cut);
    if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) {
      cut -= 1;
    }
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest !== '') {
    parts.push(rest);
  }
  return parts;
}

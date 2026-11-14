import type { TurnInputItem } from '@truefoundry/trueforge-core/agent-session';
import type { UserContentPart } from '@truefoundry/trueforge-core/core/events/schema';
import { untrustedDocumentTag } from '@truefoundry/trueforge-core/core/runtime/contextUtils';
import type { Logger } from 'winston';

import type { ITelegramStore, TelegramConnection, TelegramPendingApproval } from '../../db/telegramStore';
import type { TelegramCallbackQuery, TelegramMessage, TelegramUpdate, TelegramUser } from '../../schemas/telegram';
import type { TelegramClient } from './telegramClient';
import { sendTelegramText, type TelegramSendQueue } from './telegramSendQueue';
import { newPairingCode, TELEGRAM_PAIRING_TTL_MS, type TelegramService } from './telegramService';

/**
 * What one Telegram update does. The bot talks only to the one person it is paired with, in a
 * private chat: group chats are refused, everyone else is refused, and a message from the paired
 * person becomes a turn in the dedicated Telegram chat. Held actions come back as buttons; a tap
 * is submitted as an approval answer on the same session, through the same path the app uses.
 * Every send goes through the queue, and a failed send is never retried here: the answer stays
 * in the app, where it always lands first. Each update is claimed before it is handled, so a
 * copy delivered twice starts no second turn, and a refusal to a stranger's chat is repeated
 * only after a while, so a stranger cannot keep the shared queue busy.
 */

/** The biggest file the channel will fetch from Telegram and attach to a turn. */
export const TELEGRAM_MAX_FILE_BYTES = 10 * 1024 * 1024;

/** The title of the one chat Telegram messages land in. */
export const TELEGRAM_CHAT_TITLE = 'Telegram';

/** Session metadata key marking the Telegram chat, as the Reminders chat is marked. */
export const TELEGRAM_METADATA_KEY = 'is_telegram';

/** The external id of an owner's Telegram chat: one chat per owner, found or made by this key. */
export function telegramExternalId(ownerSubjectId: string): string {
  return `telegram:${ownerSubjectId}`;
}

const PRIVATE_REFUSAL = 'This bot is private. It answers only the person it is paired with.';
const GROUP_REFUSAL = 'This bot only talks one to one. Message it directly instead.';
const NOT_PAIRED_REFUSAL = 'This bot is private. Pair it first in Aman, under Settings, Connectors, Telegram.';
const PAIRING_BUSY = 'Someone is pairing with this bot right now. If that is not you, this bot is private.';
const ALREADY_PAIRED = 'You are paired already. Send a message and it will be answered here.';
const UNSUPPORTED_MESSAGE = 'I can only read text, photos and files here. Send one of those instead.';
const TURN_START_FAILED = 'That message could not be started. Open Aman and try again there.';

/** Starts and answers turns for the channel. The server wires it to the real turn machinery. */
export interface TelegramTurnPort {
  /** Starts one turn in the Telegram chat for an accepted message. */
  startMessageTurn(input: {
    connection: TelegramConnection;
    input: TurnInputItem[];
  }): Promise<{ session_id: string; turn_id: string }>;
  /** Submits one button answer as an approval turn after the turn that asked. */
  submitApproval(input: {
    connection: TelegramConnection;
    approval: TelegramPendingApproval;
    decision: 'allow' | 'deny';
  }): Promise<{ session_id: string; turn_id: string }>;
}

export interface TelegramChannelDeps {
  store: ITelegramStore;
  service: TelegramService;
  queue: TelegramSendQueue;
  turns: TelegramTurnPort;
  logger: Logger;
  /** How often a refusal may be repeated to a chat that is not the paired person's. */
  refusals: TelegramRefusalThrottle;
  now?: () => Date;
  newCode?: () => string;
}

/** How long a refusal stands before the same chat may be told again. */
export const TELEGRAM_REFUSAL_COOLDOWN_MS = 10 * 60 * 1000;

/**
 * Remembers when each chat was last refused, so a stranger writing again and again is told
 * once, not once per message. Every refusal rides the shared send queue, so an unthrottled
 * stranger could keep the queue busy and delay the paired person's replies.
 */
export interface TelegramRefusalThrottle {
  /** True, and remembers the telling, when a refusal may be sent to this chat now. */
  allow(input: { connection_id: string; chat_id: string; now: Date }): boolean;
}

export function createTelegramRefusalThrottle(
  cooldownMs: number = TELEGRAM_REFUSAL_COOLDOWN_MS,
): TelegramRefusalThrottle {
  const lastToldAt = new Map<string, number>();
  return {
    allow({ connection_id, chat_id, now }) {
      const key = `${connection_id}:${chat_id}`;
      const last = lastToldAt.get(key);
      if (last !== undefined && now.getTime() - last < cooldownMs) {
        return false;
      }
      lastToldAt.set(key, now.getTime());
      if (lastToldAt.size > 512) {
        for (const [entry, toldAt] of lastToldAt) {
          if (now.getTime() - toldAt >= cooldownMs) {
            lastToldAt.delete(entry);
          }
        }
      }
      return true;
    },
  };
}

function ownerOf(connection: TelegramConnection): { tenant_id: string; created_by: string } {
  return { tenant_id: connection.tenant_id, created_by: connection.created_by };
}

async function say(deps: TelegramChannelDeps, client: TelegramClient, chat_id: string, text: string): Promise<void> {
  await sendTelegramText({ queue: deps.queue, client, chat_id, text });
}

/** A refusal to a chat that is not the paired person's, sent at most once per cooldown. */
async function sayRefusal(
  deps: TelegramChannelDeps,
  connection: TelegramConnection,
  client: TelegramClient,
  chat_id: string,
  text: string,
): Promise<void> {
  const now = (deps.now ?? (() => new Date()))();
  if (!deps.refusals.allow({ connection_id: connection.id, chat_id, now })) {
    return;
  }
  await say(deps, client, chat_id, text);
}

/** The waiting person's name as Settings shows it: their Telegram name, with their username when they have one. */
export function telegramDisplayName(from: TelegramUser): string {
  const name = from.first_name ?? '';
  if (name !== '' && from.username !== undefined) {
    return `${name} (@${from.username})`;
  }
  if (name !== '') {
    return name;
  }
  return from.username !== undefined ? `@${from.username}` : 'Someone on Telegram';
}

/** The spans of a text that are links, which are not the person's own words even in their own message. */
function linkSpans(message: TelegramMessage, text: string): { start: number; end: number }[] {
  const entities = message.text === undefined ? message.caption_entities : message.entities;
  const spans: { start: number; end: number }[] = [];
  for (const entity of entities ?? []) {
    if (entity.type !== 'url' && entity.type !== 'text_link') {
      continue;
    }
    const start = Math.max(0, Math.min(entity.offset, text.length));
    const end = Math.max(start, Math.min(entity.offset + entity.length, text.length));
    if (end > start) {
      spans.push({ start, end });
    }
  }
  return spans.sort((a, b) => a.start - b.start);
}

/**
 * Splits a message text into content parts: the person's words stay as they are, each link is
 * wrapped as untrusted data, and a forwarded message is untrusted whole. The turn machinery
 * records exactly this split in the turn's provenance.
 */
export function telegramTextParts(message: TelegramMessage, text: string): UserContentPart[] {
  if (message.forward_origin !== undefined) {
    return [{ type: 'text', text: untrustedDocumentTag(text) }];
  }
  const spans = linkSpans(message, text);
  if (spans.length === 0) {
    return [{ type: 'text', text }];
  }
  const parts: UserContentPart[] = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.start > cursor) {
      parts.push({ type: 'text', text: text.slice(cursor, span.start) });
    }
    if (span.start >= cursor) {
      parts.push({ type: 'text', text: untrustedDocumentTag(text.slice(span.start, span.end)) });
    }
    cursor = Math.max(cursor, span.end);
  }
  if (cursor < text.length) {
    parts.push({ type: 'text', text: text.slice(cursor) });
  }
  return parts.filter(part => part.type !== 'text' || part.text !== '');
}

/**
 * Fetches one attachment as a file part, or the plain note that stands in for it when it cannot
 * be attached. A forwarded message is marked untrusted by the caller, next to the file part:
 * the file part itself carries no such mark, and a file forwarded from elsewhere is data, not
 * the person's own words.
 */
async function attachmentPart(
  deps: TelegramChannelDeps,
  client: TelegramClient,
  message: TelegramMessage,
): Promise<UserContentPart | undefined> {
  const photo = message.photo?.at(-1);
  const file =
    photo !== undefined
      ? { file_id: photo.file_id, name: 'photo.jpg', mime: 'image/jpeg', size: photo.file_size }
      : message.document !== undefined
        ? {
            file_id: message.document.file_id,
            name: message.document.file_name ?? 'file',
            mime: message.document.mime_type ?? 'application/octet-stream',
            size: message.document.file_size,
          }
        : undefined;
  if (file === undefined) {
    return undefined;
  }
  const forwarded = message.forward_origin !== undefined;
  const sentBy = forwarded ? 'A file forwarded with this message' : 'The person sent a file';
  if (file.size !== undefined && file.size > TELEGRAM_MAX_FILE_BYTES) {
    return {
      type: 'text',
      text: `${sentBy} called ${file.name}, but it is too big to attach here, so it was not read.`,
    };
  }
  try {
    const bytes = await client.downloadFile({ file_id: file.file_id });
    if (bytes.byteLength > TELEGRAM_MAX_FILE_BYTES) {
      return {
        type: 'text',
        text: `${sentBy} called ${file.name}, but it is too big to attach here, so it was not read.`,
      };
    }
    return {
      type: 'file',
      name: file.name,
      data: `data:${file.mime};base64,${Buffer.from(bytes).toString('base64')}`,
    };
  } catch (error) {
    deps.logger.warn('A Telegram attachment could not be fetched', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      type: 'text',
      text: `${sentBy} called ${file.name}, but it could not be downloaded, so it was not read.`,
    };
  }
}

/** Builds the turn input for one accepted message, or undefined when the message carries nothing readable. */
export async function telegramTurnInput(
  deps: TelegramChannelDeps,
  client: TelegramClient,
  message: TelegramMessage,
): Promise<TurnInputItem[] | undefined> {
  const parts: UserContentPart[] = [];
  const text = message.text ?? message.caption;
  if (text !== undefined && text.trim() !== '') {
    parts.push(...telegramTextParts(message, text));
  }
  const attachment = await attachmentPart(deps, client, message);
  if (attachment !== undefined) {
    if (message.forward_origin !== undefined && attachment.type === 'file') {
      // Text from a forwarded message is wrapped as untrusted whole, and a forwarded file
      // needs the same mark next to it: the file part itself carries none.
      parts.push({
        type: 'text',
        text: untrustedDocumentTag(
          `A file forwarded from somewhere else is attached: ${attachment.name}. It came from someone else, not from the person.`,
        ),
      });
    }
    parts.push(attachment);
  }
  if (parts.length === 0) {
    return undefined;
  }
  const only = parts.length === 1 ? parts[0] : undefined;
  return [
    {
      type: 'user.message',
      content: only?.type === 'text' && message.forward_origin === undefined ? only.text : parts,
    },
  ];
}

async function handleStart(
  deps: TelegramChannelDeps,
  client: TelegramClient,
  connection: TelegramConnection,
  message: TelegramMessage,
): Promise<void> {
  const now = (deps.now ?? (() => new Date()))();
  const chat_id = String(message.chat.id);
  const user_id = String(message.from?.id ?? '');
  if (connection.paired_telegram_user_id !== null) {
    if (connection.paired_telegram_user_id === user_id) {
      await say(deps, client, chat_id, ALREADY_PAIRED);
    } else {
      await sayRefusal(deps, connection, client, chat_id, PRIVATE_REFUSAL);
    }
    return;
  }
  const codeLive =
    connection.pairing_code !== null &&
    connection.pairing_expires_at !== null &&
    new Date(connection.pairing_expires_at).getTime() > now.getTime();
  if (codeLive && connection.pairing_telegram_user_id !== user_id) {
    await sayRefusal(deps, connection, client, chat_id, PAIRING_BUSY);
    return;
  }
  const code = (deps.newCode ?? newPairingCode)();
  await deps.store.startPairing({
    ...ownerOf(connection),
    code,
    expires_at: new Date(now.getTime() + TELEGRAM_PAIRING_TTL_MS),
    telegram_user_id: user_id,
    chat_id,
    display_name: message.from === undefined ? 'Someone on Telegram' : telegramDisplayName(message.from),
    now,
  });
  await say(
    deps,
    client,
    chat_id,
    `Your pairing code is ${code}. In Aman, open Settings, then Connectors, then Telegram, and enter this code to finish pairing. Settings will show your name as the person waiting to pair, so you can check it is you. The code works for 15 minutes.`,
  );
}

async function handleMessage(
  deps: TelegramChannelDeps,
  connection: TelegramConnection,
  message: TelegramMessage,
): Promise<void> {
  const client = deps.service.clientFor(connection);
  const chat_id = String(message.chat.id);
  if (message.chat.type !== 'private') {
    await sayRefusal(deps, connection, client, chat_id, GROUP_REFUSAL);
    return;
  }
  if (message.from === undefined) {
    return;
  }
  const user_id = String(message.from.id);
  const text = (message.text ?? '').trim();
  if (connection.paired_telegram_user_id === null) {
    if (text === '/start' || text.startsWith('/start ')) {
      await handleStart(deps, client, connection, message);
      return;
    }
    await sayRefusal(deps, connection, client, chat_id, NOT_PAIRED_REFUSAL);
    return;
  }
  if (connection.paired_telegram_user_id !== user_id) {
    await sayRefusal(deps, connection, client, chat_id, PRIVATE_REFUSAL);
    return;
  }
  if (text === '/start' || text.startsWith('/start ')) {
    await say(deps, client, chat_id, ALREADY_PAIRED);
    return;
  }
  const input = await telegramTurnInput(deps, client, message);
  if (input === undefined) {
    await say(deps, client, chat_id, UNSUPPORTED_MESSAGE);
    return;
  }
  try {
    const started = await deps.turns.startMessageTurn({ connection, input });
    await deps.store.addPendingReply({
      ...ownerOf(connection),
      connection_id: connection.id,
      session_id: started.session_id,
      turn_id: started.turn_id,
      chat_id,
    });
  } catch (error) {
    deps.logger.warn('A Telegram message could not be started as a turn', {
      connection_id: connection.id,
      error: error instanceof Error ? error.message : String(error),
    });
    await say(deps, client, chat_id, TURN_START_FAILED).catch(() => undefined);
  }
}

const CALLBACK_PREFIX = 'tg:';

export function telegramCallbackData(input: { decision: 'allow' | 'deny'; approval_id: string }): string {
  return `${CALLBACK_PREFIX}${input.decision === 'allow' ? 'a' : 'd'}:${input.approval_id}`;
}

function parseCallbackData(data: string | undefined): { decision: 'allow' | 'deny'; approval_id: string } | undefined {
  if (!data?.startsWith(CALLBACK_PREFIX)) {
    return undefined;
  }
  const [kind, approval_id] = data.slice(CALLBACK_PREFIX.length).split(':');
  if ((kind !== 'a' && kind !== 'd') || approval_id === undefined || approval_id === '') {
    return undefined;
  }
  return { decision: kind === 'a' ? 'allow' : 'deny', approval_id };
}

async function handleCallback(
  deps: TelegramChannelDeps,
  connection: TelegramConnection,
  query: TelegramCallbackQuery,
): Promise<void> {
  const client = deps.service.clientFor(connection);
  const answer = async (text: string): Promise<void> => {
    await client.answerCallbackQuery({ callback_query_id: query.id, text }).catch((error: unknown) => {
      deps.logger.warn('A Telegram button answer could not be confirmed', {
        connection_id: connection.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };
  const parsed = parseCallbackData(query.data);
  if (parsed === undefined) {
    await answer('That button is out of date.');
    return;
  }
  const approval = await deps.store.getPendingApproval({ id: parsed.approval_id });
  if (approval?.connection_id !== connection.id) {
    await answer('That was already answered.');
    return;
  }
  if (connection.paired_telegram_user_id === null || String(query.from.id) !== connection.paired_telegram_user_id) {
    await answer('Only the person this bot is paired with can answer that.');
    return;
  }
  const now = (deps.now ?? (() => new Date()))();
  if (approval.expires_at !== null && new Date(approval.expires_at).getTime() <= now.getTime()) {
    await deps.store.deletePendingApproval({ id: approval.id });
    await answer('That action has expired. Open Aman to see it.');
    return;
  }
  try {
    const started = await deps.turns.submitApproval({ connection, approval, decision: parsed.decision });
    await deps.store.deletePendingApproval({ id: approval.id });
    await deps.store.addPendingReply({
      ...ownerOf(connection),
      connection_id: connection.id,
      session_id: started.session_id,
      turn_id: started.turn_id,
      chat_id: approval.chat_id,
    });
    await answer(
      parsed.decision === 'allow' ? 'Approved. The answer will arrive here.' : 'Denied. The answer will arrive here.',
    );
  } catch (error) {
    deps.logger.warn('A Telegram approval could not be submitted', {
      connection_id: connection.id,
      error: error instanceof Error ? error.message : String(error),
    });
    await answer('That could not be sent. Open Aman and answer it there.');
  }
}

/**
 * Handles one update for its connection. The update is claimed first, in one store write, so a
 * copy Telegram delivers twice (a poll answer the controller timed out on, a webhook retry) is
 * handled once and its twin is dropped here. A failure to claim is the one error that still
 * throws: the caller then treats the update as not accepted and Telegram delivers it again,
 * instead of it being lost. Once claimed, handling never throws: a bad update is logged and
 * dropped.
 */
export async function processTelegramUpdate(
  deps: TelegramChannelDeps,
  input: { connection: TelegramConnection; update: TelegramUpdate },
): Promise<void> {
  const claimed = await deps.store.claimUpdate({
    connection_id: input.connection.id,
    update_id: String(input.update.update_id),
  });
  if (!claimed) {
    return;
  }
  try {
    if (input.update.callback_query !== undefined) {
      await handleCallback(deps, input.connection, input.update.callback_query);
      return;
    }
    if (input.update.message !== undefined) {
      await handleMessage(deps, input.connection, input.update.message);
    }
  } catch (error) {
    deps.logger.warn('A Telegram update could not be handled', {
      connection_id: input.connection.id,
      update_id: input.update.update_id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Maps Aman's stored sessions onto the common chat format (see
 * commonChatFormat.ts). Only the main thread's conversation is mapped:
 * sub-agent threads, system prompts, host notes, tool calls, and tool results
 * stay in the full-fidelity sessions section and are not chat messages.
 *
 * Message times come from the turns: context messages carry no timestamps,
 * so each message takes the creation time of the first turn whose context
 * contains it. Contexts are cumulative, so the walk tracks the shared
 * prefix between consecutive turns; after a context overwrite (compaction)
 * the prefix breaks and the surviving messages take the overwriting turn's
 * time.
 */
import { MAIN_THREAD_ID, type SessionRecord, type TurnRecord } from '@truefoundry/trueforge-core/agent-session';
import { isInternalSystemMessage, type ContextMessage } from '@truefoundry/trueforge-core/core';

import type { SessionCustom, TurnCustom } from '../db/sessionCustom';
import type { CommonChat, CommonChatFile, CommonChatMessage } from './commonChatFormat';

function iso(value: Date | string): string {
  // Not instanceof: store records can carry Dates from another module realm.
  return typeof value === 'string' ? value : new Date(value).toISOString();
}

interface ExtractedContent {
  text: string;
  files: CommonChatFile[];
}

/** Reads one property of an unknown value without asserting its shape. */
function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined;
}

/** Pulls readable text and attachment names out of one context message's content. */
function extractContent(content: unknown): ExtractedContent {
  if (typeof content === 'string') {
    return { text: content, files: [] };
  }
  if (!Array.isArray(content)) {
    return { text: '', files: [] };
  }
  const texts: string[] = [];
  const files: CommonChatFile[] = [];
  for (const part of content) {
    const type = field(part, 'type');
    const text = field(part, 'text');
    if (type === 'text' && typeof text === 'string') {
      texts.push(text);
    } else if (type === 'file') {
      const filename = field(field(part, 'file'), 'filename');
      files.push({ name: typeof filename === 'string' && filename.length > 0 ? filename : 'attachment' });
    } else if (type === 'image_url') {
      files.push({ name: 'image' });
    }
  }
  return { text: texts.join('\n'), files };
}

/** Host notes ride in user-role messages; they are not something the user or the assistant said. */
function toCommonMessage(message: ContextMessage, time: string): CommonChatMessage | undefined {
  if (isInternalSystemMessage(message)) {
    return undefined;
  }
  const role = field(message, 'role');
  if (role !== 'user' && role !== 'assistant') {
    return undefined;
  }
  const { text, files } = extractContent(field(message, 'content'));
  if (text.trim().length === 0 && files.length === 0) {
    return undefined;
  }
  return {
    author: role === 'user' ? 'you' : 'assistant',
    text,
    time,
    ...(files.length > 0 ? { files } : {}),
  };
}

function messageKey(message: ContextMessage): string {
  return JSON.stringify(message);
}

const TITLE_MAX_LENGTH = 80;

function deriveTitle(messages: readonly CommonChatMessage[]): string {
  const firstUser = messages.find(message => message.author === 'you');
  if (firstUser === undefined) {
    return 'Untitled chat';
  }
  const firstLine = firstUser.text.split('\n', 1)[0]?.trim() ?? '';
  if (firstLine.length === 0) {
    return 'Untitled chat';
  }
  return firstLine.length > TITLE_MAX_LENGTH ? `${firstLine.slice(0, TITLE_MAX_LENGTH - 1)}…` : firstLine;
}

/**
 * Builds one common chat from a session and its turns (oldest first, full
 * records with snapshots). `folderName` is the session's folder name, when
 * the session sits in a folder that still exists.
 */
export function sessionToCommonChat(input: {
  session: SessionRecord<SessionCustom>;
  turns: readonly TurnRecord<TurnCustom>[];
  folderName: string | undefined;
}): CommonChat {
  const { session, turns, folderName } = input;
  let previousKeys: string[] = [];
  let timed: { message: ContextMessage; time: string }[] = [];
  for (const turn of turns) {
    const context = turn.snapshot.threads[MAIN_THREAD_ID]?.context ?? [];
    const keys = context.map(messageKey);
    let prefix = 0;
    while (
      prefix < keys.length &&
      prefix < previousKeys.length &&
      keys[prefix] === previousKeys[prefix] &&
      timed[prefix] !== undefined
    ) {
      prefix += 1;
    }
    const turnTime = iso(turn.created_at);
    timed = context.map((message, index) => {
      const kept = index < prefix ? timed[index] : undefined;
      return kept ?? { message, time: turnTime };
    });
    previousKeys = keys;
  }
  const messages: CommonChatMessage[] = [];
  for (const entry of timed) {
    const mapped = toCommonMessage(entry.message, entry.time);
    if (mapped !== undefined) {
      messages.push(mapped);
    }
  }
  return {
    title: session.title ?? deriveTitle(messages),
    created_at: iso(session.created_at),
    updated_at: iso(session.updated_at),
    ...(folderName !== undefined ? { folder: folderName } : {}),
    messages,
  };
}

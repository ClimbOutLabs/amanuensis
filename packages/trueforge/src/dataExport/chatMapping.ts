/**
 * Maps Aman's stored sessions onto the common chat format
 * ({@link ./commonChatFormat}). Only the main thread's conversation is
 * mapped: sub-agent threads, system prompts, tool calls, and tool results
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
import type { ContextMessage } from '@truefoundry/trueforge-core/core';

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
    if (typeof part !== 'object' || part === null) {
      continue;
    }
    const record = part as Record<string, unknown>;
    if (record['type'] === 'text' && typeof record['text'] === 'string') {
      texts.push(record['text']);
    } else if (record['type'] === 'file') {
      const file = record['file'];
      const filename =
        typeof file === 'object' && file !== null && typeof (file as Record<string, unknown>)['filename'] === 'string'
          ? (file as Record<string, unknown>)['filename']
          : undefined;
      files.push({ name: typeof filename === 'string' && filename.length > 0 ? filename : 'attachment' });
    } else if (record['type'] === 'image_url') {
      files.push({ name: 'image' });
    }
  }
  return { text: texts.join('\n'), files };
}

function toCommonMessage(message: ContextMessage, time: string): CommonChatMessage | undefined {
  const role = (message as { role?: unknown }).role;
  if (role !== 'user' && role !== 'assistant') {
    return undefined;
  }
  const { text, files } = extractContent((message as { content?: unknown }).content);
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

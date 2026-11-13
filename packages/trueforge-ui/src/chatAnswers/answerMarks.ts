import type { ChatAnswerMark } from './types.js';

/**
 * This browser's record of how far the person has read each chat: for each chat id, the
 * latest answer time the person has seen, or the time they opened the chat. The record
 * lives in this browser only; the delivery feed is the place where seen is shared between
 * devices, and it tracks its own items, not chat answers.
 */
export type SeenAnswerMarks = Readonly<Record<string, string>>;

/** Where this browser keeps its seen-answer record (browser local storage). */
export const CHAT_ANSWERS_SEEN_STORAGE_KEY = 'aman.chatAnswers.seen.v1';

/** The smallest storage shape the seen record needs, so tests can stand in for local storage. */
export type SeenMarksStorage = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
};

/**
 * Chats with an answer the person has not seen in this browser yet: the chat's latest
 * answer is newer than the newest answer this browser recorded as seen for it.
 */
export function unseenAnswerChatIds(input: {
  marks: readonly ChatAnswerMark[];
  seen: SeenAnswerMarks;
}): ReadonlySet<string> {
  const unseen = new Set<string>();
  for (const mark of input.marks) {
    const seenAt = input.seen[mark.sessionId];
    if (seenAt === undefined || Date.parse(mark.answeredAt) > Date.parse(seenAt)) {
      unseen.add(mark.sessionId);
    }
  }
  return unseen;
}

/**
 * Merges two seen records key by key, keeping the later time for each chat. Tabs of the
 * same browser share the stored record, so a write must fold in what another tab recorded
 * instead of replacing the whole record with this tab's older copy.
 */
export function mergeSeenAnswerMarks(first: SeenAnswerMarks, second: SeenAnswerMarks): Record<string, string> {
  const merged: Record<string, string> = { ...first };
  for (const [sessionId, seenAt] of Object.entries(second)) {
    const current = merged[sessionId];
    if (current === undefined || Date.parse(seenAt) > Date.parse(current)) {
      merged[sessionId] = seenAt;
    }
  }
  return merged;
}

/**
 * The first record this browser keeps: every answer that already exists counts as seen, so
 * a person opening the app for the first time does not find every old chat dotted. A chat
 * the person opened before the first check keeps whichever mark is later, so an answer
 * they already read never dots.
 */
export function baselineSeenAnswerMarks(input: {
  marks: readonly ChatAnswerMark[];
  opened: SeenAnswerMarks;
}): Record<string, string> {
  const fromMarks: Record<string, string> = {};
  for (const mark of input.marks) {
    fromMarks[mark.sessionId] = mark.answeredAt;
  }
  return mergeSeenAnswerMarks(fromMarks, input.opened);
}

/**
 * Reads the seen record. Null means this browser has never kept one (a first run, which the
 * caller answers with a baseline); a damaged record reads as an empty one rather than
 * breaking the chat list.
 */
export function readSeenAnswerMarks(storage: SeenMarksStorage): Record<string, string> | null {
  let raw: string | null;
  try {
    raw = storage.getItem(CHAT_ANSWERS_SEEN_STORAGE_KEY);
  } catch {
    return {};
  }
  if (raw === null) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {};
  }
  const seen: Record<string, string> = {};
  for (const [sessionId, seenAt] of Object.entries(parsed)) {
    if (typeof seenAt === 'string') {
      seen[sessionId] = seenAt;
    }
  }
  return seen;
}

/** Keeps the seen record in this browser. A browser that refuses storage simply forgets. */
export function writeSeenAnswerMarks(storage: SeenMarksStorage, seen: SeenAnswerMarks): void {
  try {
    storage.setItem(CHAT_ANSWERS_SEEN_STORAGE_KEY, JSON.stringify(seen));
  } catch {
    // The dots still work for this page view; they just start fresh next time.
  }
}

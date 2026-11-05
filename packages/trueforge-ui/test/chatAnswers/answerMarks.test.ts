import { describe, expect, it } from 'vitest';

import {
  CHAT_ANSWERS_SEEN_STORAGE_KEY,
  baselineSeenAnswerMarks,
  mergeSeenAnswerMarks,
  readSeenAnswerMarks,
  unseenAnswerChatIds,
  writeSeenAnswerMarks,
  type SeenMarksStorage,
} from '@/chatAnswers/answerMarks.js';

const T1 = '2026-11-03T10:00:00.000Z';
const T2 = '2026-11-03T12:00:00.000Z';

function memoryStorage(initial?: string): SeenMarksStorage & { read: () => string | null } {
  let value = initial ?? null;
  return {
    getItem: () => value,
    setItem: (_key, next) => {
      value = next;
    },
    read: () => value,
  };
}

describe('unseenAnswerChatIds', () => {
  it('marks a chat whose latest answer is newer than what the browser saw', () => {
    const unseen = unseenAnswerChatIds({
      marks: [
        { sessionId: 'chat-a', answeredAt: T2 },
        { sessionId: 'chat-b', answeredAt: T1 },
      ],
      seen: { 'chat-a': T1, 'chat-b': T1 },
    });
    expect([...unseen]).toEqual(['chat-a']);
  });

  it('marks a chat the browser has no record of', () => {
    const unseen = unseenAnswerChatIds({ marks: [{ sessionId: 'chat-a', answeredAt: T1 }], seen: {} });
    expect([...unseen]).toEqual(['chat-a']);
  });

  it('marks nothing when every answer was seen', () => {
    const unseen = unseenAnswerChatIds({ marks: [{ sessionId: 'chat-a', answeredAt: T1 }], seen: { 'chat-a': T2 } });
    expect(unseen.size).toBe(0);
  });
});

describe('baselineSeenAnswerMarks', () => {
  it('takes every existing answer as seen', () => {
    expect(baselineSeenAnswerMarks({ marks: [{ sessionId: 'chat-a', answeredAt: T1 }], opened: {} })).toEqual({
      'chat-a': T1,
    });
  });

  it('keeps the later mark for a chat opened before the first check', () => {
    expect(
      baselineSeenAnswerMarks({ marks: [{ sessionId: 'chat-a', answeredAt: T1 }], opened: { 'chat-a': T2 } }),
    ).toEqual({ 'chat-a': T2 });
    expect(
      baselineSeenAnswerMarks({ marks: [{ sessionId: 'chat-a', answeredAt: T2 }], opened: { 'chat-a': T1 } }),
    ).toEqual({ 'chat-a': T2 });
  });
});

describe('mergeSeenAnswerMarks', () => {
  it('keeps the later time per chat and the union of both records', () => {
    expect(mergeSeenAnswerMarks({ 'chat-a': T2, 'chat-b': T1 }, { 'chat-a': T1, 'chat-c': T2 })).toEqual({
      'chat-a': T2,
      'chat-b': T1,
      'chat-c': T2,
    });
    expect(mergeSeenAnswerMarks({ 'chat-a': T1 }, { 'chat-a': T2 })).toEqual({ 'chat-a': T2 });
  });

  it('does not mutate either record', () => {
    const first = { 'chat-a': T1 };
    const second = { 'chat-a': T2 };
    mergeSeenAnswerMarks(first, second);
    expect(first).toEqual({ 'chat-a': T1 });
    expect(second).toEqual({ 'chat-a': T2 });
  });
});

describe('the stored seen record', () => {
  it('reads back what was written', () => {
    const storage = memoryStorage();
    writeSeenAnswerMarks(storage, { 'chat-a': T1 });
    expect(storage.read()).toBe(JSON.stringify({ 'chat-a': T1 }));
    expect(readSeenAnswerMarks(storage)).toEqual({ 'chat-a': T1 });
  });

  it('reports no record on a first run, and an empty one for a damaged record', () => {
    expect(readSeenAnswerMarks(memoryStorage())).toBeNull();
    expect(readSeenAnswerMarks(memoryStorage('not json'))).toEqual({});
    expect(readSeenAnswerMarks(memoryStorage('{"chat-a": 5}'))).toEqual({});
  });

  it('uses the one storage key', () => {
    const storage = memoryStorage();
    writeSeenAnswerMarks(storage, {});
    expect(CHAT_ANSWERS_SEEN_STORAGE_KEY).toBe('aman.chatAnswers.seen.v1');
  });
});

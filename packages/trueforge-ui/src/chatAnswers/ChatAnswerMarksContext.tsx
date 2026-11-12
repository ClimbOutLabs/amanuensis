'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FC,
  type ReactNode,
} from 'react';

import {
  baselineSeenAnswerMarks,
  CHAT_ANSWERS_SEEN_STORAGE_KEY,
  mergeSeenAnswerMarks,
  readSeenAnswerMarks,
  unseenAnswerChatIds,
  writeSeenAnswerMarks,
  type SeenAnswerMarks,
} from './answerMarks.js';
import type { ChatAnswerMark, ChatAnswerMarksApi } from './types.js';

/** How often an open page asks for the chats' latest answer times. */
export const CHAT_ANSWER_MARKS_POLL_MS = 30_000;

type ChatAnswerMarksValue = {
  /** Chats whose latest answer this browser has not seen the person open yet. */
  unseenAnswerChatIds: ReadonlySet<string>;
  /** Each chat's latest answer stamp as last fetched, keyed by chat id. */
  answerStampsByChatId: ReadonlyMap<string, string>;
  /** Records that the person opened this chat, so its dot clears. */
  markAnswerSeen: (sessionId: string) => void;
};

const ChatAnswerMarksContext = createContext<ChatAnswerMarksValue | null>(null);

export function useOptionalChatAnswerMarks(): ChatAnswerMarksValue | null {
  return useContext(ChatAnswerMarksContext);
}

function browserStorage(): {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
} | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * The chat list's unseen-answer marks. The server stamps each chat with the time its
 * latest answer landed; this browser remembers how far the person has read each chat, and
 * a chat is marked while its stamp is newer than that memory. The first check in a browser
 * takes every answer that already exists as seen, so old chats do not all light up at
 * once. While the page is visible it asks every 30 seconds. The record is this browser's
 * alone: reading a chat on the phone does not clear its dot on the laptop.
 */
export const ChatAnswerMarksProvider: FC<{ api: ChatAnswerMarksApi; pollMs?: number; children: ReactNode }> = ({
  api,
  pollMs = CHAT_ANSWER_MARKS_POLL_MS,
  children,
}) => {
  const [marks, setMarks] = useState<readonly ChatAnswerMark[]>([]);
  const [seen, setSeen] = useState<SeenAnswerMarks | null>(() => {
    const storage = browserStorage();
    return storage === null ? {} : readSeenAnswerMarks(storage);
  });
  const seenRef = useRef(seen);
  const marksRef = useRef(marks);
  // A stored record means an earlier visit already took the baseline. Opening a chat
  // before the first check writes a partial record, and that must not count as one.
  const baselinedRef = useRef(seen !== null);

  const applySeen = useCallback((next: SeenAnswerMarks) => {
    const storage = browserStorage();
    // Tabs of this browser share the stored record: re-read it and merge per key
    // before writing, so this write cannot erase a chat another tab just recorded.
    const stored = storage === null ? null : readSeenAnswerMarks(storage);
    const merged = stored === null ? { ...next } : mergeSeenAnswerMarks(stored, next);
    seenRef.current = merged;
    setSeen(merged);
    if (storage !== null) {
      writeSeenAnswerMarks(storage, merged);
    }
  }, []);

  // The same merge in the other direction: when another tab writes the record, take
  // its marks in so this tab's dots agree with what the person already read there.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== CHAT_ANSWERS_SEEN_STORAGE_KEY || seenRef.current === null) {
        return;
      }
      const storage = browserStorage();
      if (storage === null) {
        return;
      }
      const stored = readSeenAnswerMarks(storage);
      if (stored === null) {
        return;
      }
      const merged = mergeSeenAnswerMarks(seenRef.current, stored);
      seenRef.current = merged;
      setSeen(merged);
    };
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const fetched = await api.listAnswerMarks();
      marksRef.current = fetched;
      setMarks(fetched);
      if (!baselinedRef.current) {
        // First check in this browser: everything already answered counts as seen.
        baselinedRef.current = true;
        applySeen(baselineSeenAnswerMarks({ marks: fetched, opened: seenRef.current ?? {} }));
      }
    } catch {
      // A missed check is tried again on the next one.
    }
  }, [api, applySeen]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, pollMs);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh, pollMs]);

  const markAnswerSeen = useCallback(
    (sessionId: string) => {
      // Seen is always a stamp, the turn's own completion time, never this browser's
      // clock: a clock-written time can sit after a stamp the person has not actually
      // read (hiding its dot for good) or before one they have (dotting a chat they
      // just read). With no stamp known yet there is nothing to record; the next check
      // brings the stamp, and the list marks a still-open chat seen when it arrives.
      const known = marksRef.current.find(mark => mark.sessionId === sessionId);
      if (known === undefined) {
        return;
      }
      const current = seenRef.current ?? {};
      if (current[sessionId] === known.answeredAt) {
        return;
      }
      applySeen({ ...current, [sessionId]: known.answeredAt });
    },
    [applySeen],
  );

  const unseen = useMemo(
    () => (seen === null ? new Set<string>() : unseenAnswerChatIds({ marks, seen })),
    [marks, seen],
  );

  const answerStampsByChatId = useMemo(() => new Map(marks.map(mark => [mark.sessionId, mark.answeredAt])), [marks]);

  const value = useMemo<ChatAnswerMarksValue>(
    () => ({ unseenAnswerChatIds: unseen, answerStampsByChatId, markAnswerSeen }),
    [unseen, answerStampsByChatId, markAnswerSeen],
  );

  return <ChatAnswerMarksContext.Provider value={value}>{children}</ChatAnswerMarksContext.Provider>;
};

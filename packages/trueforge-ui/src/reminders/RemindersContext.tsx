'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { sessionRemindersMarker, type RemindersMarker } from '../atoms/lib/sessionReminders.js';
import { useOptionalServer } from '../server/ServerContext.js';

/** How often the open tab asks whether a reminder has come in. */
export const REMINDERS_POLL_MS = 30_000;
/** Pages of recent chats looked through to find the Reminders chat, 50 chats each, when the page opens or a reminder is set. */
const FULL_FIND_PAGES = 3;
const FIND_PAGE_SIZE = 50;

const SEEN_AT_KEY = 'aman.reminders.seen_at';
const NOTIFIED_AT_KEY = 'aman.reminders.notified_at';
const ASKED_KEY = 'aman.reminders.notifications_asked';
/** A reminder was set here, so the Reminders chat will appear when it is first due. */
const EXPECTING_KEY = 'aman.reminders.expecting';

function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored({ key, value }: { key: string; value: string }): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Without storage the choice lasts until the tab closes, which is all it can do.
  }
}

function notificationPermission(): NotificationPermission | 'unsupported' {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
}

type RemindersContextValue = {
  /** The Reminders chat, once the tab has found it. */
  remindersSessionId: string | null;
  /** A reminder came in that the person has not opened yet. */
  unread: boolean;
  /** The person opened the Reminders chat. */
  markSeen: () => void;
  /** A reminder was just set in a chat: look for the Reminders chat now. */
  reminderSet: () => void;
  /** True until the person has answered the one question about browser notifications. */
  shouldAskForNotifications: boolean;
  /** Asks the browser for permission; call it from the person's click. */
  allowNotifications: () => void;
  declineNotifications: () => void;
};

const RemindersContext = createContext<RemindersContextValue | null>(null);

export function useOptionalReminders(): RemindersContextValue | null {
  return useContext(RemindersContext);
}

/**
 * Watches the Reminders chat while the app is open in a tab: marks it unread until it is opened, and shows a
 * browser notification for a reminder that comes in once the person has allowed notifications. Nothing runs
 * once the tab is closed.
 */
export function RemindersProvider({ children, pollMs = REMINDERS_POLL_MS }: { children: ReactNode; pollMs?: number }) {
  const server = useOptionalServer();
  const [session, setSession] = useState<{ id: string; marker: RemindersMarker } | null>(null);
  const [seenAt, setSeenAt] = useState<string>(() => readStored(SEEN_AT_KEY) ?? '');
  const [asked, setAsked] = useState<boolean>(() => readStored(ASKED_KEY) === 'true');
  const sessionIdRef = useRef<string | null>(null);
  const expectingRef = useRef(readStored(EXPECTING_KEY) === 'true');
  const notifiedAtRef = useRef<string | null>(readStored(NOTIFIED_AT_KEY));

  const check = useCallback(
    async ({ pages }: { pages: number }) => {
      if (server == null) return;
      try {
        const knownId = sessionIdRef.current;
        if (knownId != null) {
          const marker = sessionRemindersMarker(await server.getSession({ sessionId: knownId }));
          if (marker !== null) setSession({ id: knownId, marker });
          return;
        }
        let pageToken: string | undefined;
        for (let page = 0; page < pages; page += 1) {
          const result = await server.listSessions({
            limit: FIND_PAGE_SIZE,
            order: 'desc',
            ...(pageToken === undefined ? {} : { pageToken }),
          });
          for (const candidate of result.data) {
            const marker = sessionRemindersMarker(candidate);
            if (marker !== null) {
              sessionIdRef.current = candidate.id;
              setSession({ id: candidate.id, marker });
              return;
            }
          }
          pageToken = result.nextPageToken;
          if (pageToken === undefined) return;
        }
      } catch {
        // A missed check is retried on the next one.
      }
    },
    [server],
  );

  useEffect(() => {
    void check({ pages: FULL_FIND_PAGES });
    // Until the chat is found, only a person who has set a reminder is worth looking for, and one page is enough.
    const timer = window.setInterval(() => void check({ pages: expectingRef.current ? 1 : 0 }), pollMs);
    return () => {
      window.clearInterval(timer);
    };
  }, [check, pollMs]);

  const latestAt = session?.marker.latestAt ?? '';
  const latestText = session?.marker.latestText ?? '';
  useEffect(() => {
    if (latestAt === '' || notificationPermission() !== 'granted') return;
    const notifiedAt = notifiedAtRef.current;
    notifiedAtRef.current = latestAt;
    writeStored({ key: NOTIFIED_AT_KEY, value: latestAt });
    // Allowed outside this app's own question: start from what is already there rather than announce it.
    if (notifiedAt === null || latestAt <= notifiedAt) return;
    try {
      new Notification(`Reminder: ${latestText}`);
    } catch {
      // The browser refused to show it; the unread mark still tells the person.
    }
  }, [latestAt, latestText]);

  const markSeen = useCallback(() => {
    if (latestAt === '') return;
    setSeenAt(latestAt);
    writeStored({ key: SEEN_AT_KEY, value: latestAt });
  }, [latestAt]);

  const reminderSet = useCallback(() => {
    expectingRef.current = true;
    writeStored({ key: EXPECTING_KEY, value: 'true' });
    void check({ pages: FULL_FIND_PAGES });
  }, [check]);

  const answer = useCallback(() => {
    setAsked(true);
    writeStored({ key: ASKED_KEY, value: 'true' });
  }, []);

  const allowNotifications = useCallback(() => {
    answer();
    if (typeof Notification === 'undefined') return;
    void Notification.requestPermission().then(permission => {
      if (permission !== 'granted') return;
      // Only reminders that come in from now on are announced.
      const from = new Date().toISOString();
      if (notifiedAtRef.current === null || notifiedAtRef.current < from) {
        notifiedAtRef.current = from;
        writeStored({ key: NOTIFIED_AT_KEY, value: from });
      }
    });
  }, [answer]);

  const declineNotifications = useCallback(() => {
    answer();
  }, [answer]);

  const value = useMemo<RemindersContextValue>(
    () => ({
      remindersSessionId: session?.id ?? null,
      unread: latestAt !== '' && latestAt > seenAt,
      markSeen,
      reminderSet,
      shouldAskForNotifications: !asked && notificationPermission() === 'default',
      allowNotifications,
      declineNotifications,
    }),
    [session?.id, latestAt, seenAt, markSeen, reminderSet, asked, allowNotifications, declineNotifications],
  );

  return <RemindersContext.Provider value={value}>{children}</RemindersContext.Provider>;
}

import { useEffect, useState } from 'react';

import { BROWSER_LIVE_PATH } from './browserLivePath';
import { apiPath, UI_BASE_PATH } from './publicPath';

/** How often the open chat's page is looked for while the app is in view. */
const LOOK_EVERY_MS = 15_000;

/** How long to wait after the tab list could not be read (the browser is off, or the server is busy). */
const LOOK_AGAIN_AFTER_FAILURE_MS = 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * The person's open browser tabs, by chat id; 'off' when this server has no browser; undefined when
 * the list could not be read.
 */
async function openTabIds(): Promise<string[] | 'off' | undefined> {
  // A plain fetch: a lapsed sign-in must not send the person to the sign-in page from a background check.
  const response = await fetch(apiPath('/api/browser/live/tabs'), { credentials: 'same-origin' }).catch(
    () => undefined,
  );
  if (response?.ok !== true) {
    return undefined;
  }
  const json: unknown = await response.json().catch(() => undefined);
  const data = isRecord(json) && isRecord(json.data) ? json.data : undefined;
  if (data?.browser_on === false) {
    return 'off';
  }
  const tabs = Array.isArray(data?.tabs) ? data.tabs : undefined;
  return tabs?.flatMap(tab => (isRecord(tab) && typeof tab.tab === 'string' ? [tab.tab] : []));
}

/** The live browser page's address, opened on one chat's tab. */
export function liveBrowserHrefFor(sessionId: string): string {
  return `${UI_BASE_PATH.replace(/\/$/, '')}${BROWSER_LIVE_PATH}?tab=${encodeURIComponent(sessionId)}`;
}

/**
 * The live browser page's address while the assistant has a web page open in the open chat, for
 * the rail's link to it; undefined otherwise. A private chat has no browser, so it is never asked.
 * Listing the tabs never starts a browser, and the list is only asked for while the app is in view.
 */
export function useLiveBrowserHref({
  sessionId,
  privateChat,
}: {
  sessionId: string | undefined;
  privateChat: boolean;
}): string | undefined {
  const [openFor, setOpenFor] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (sessionId === undefined || privateChat) {
      return;
    }
    let cancelled = false;
    let stopped = false;
    let timer: number | undefined;
    const look = async () => {
      if (document.visibilityState !== 'visible') {
        timer = window.setTimeout(() => void look(), LOOK_EVERY_MS);
        return;
      }
      const ids = await openTabIds();
      if (cancelled) {
        return;
      }
      // A server without a browser stays that way until it restarts, so there is nothing more to look for.
      if (ids === 'off') {
        stopped = true;
        setOpenFor(undefined);
        return;
      }
      setOpenFor(ids?.includes(sessionId) === true ? sessionId : undefined);
      timer = window.setTimeout(() => void look(), ids === undefined ? LOOK_AGAIN_AFTER_FAILURE_MS : LOOK_EVERY_MS);
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible' && !stopped) {
        window.clearTimeout(timer);
        void look();
      }
    };
    void look();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [sessionId, privateChat]);

  // A finding for another chat, or from before the chat turned private, never shows.
  return openFor !== undefined && openFor === sessionId && !privateChat ? liveBrowserHrefFor(openFor) : undefined;
}

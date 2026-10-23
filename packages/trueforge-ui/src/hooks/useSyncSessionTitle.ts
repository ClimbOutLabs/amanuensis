'use client';

import { useThreadIsRunning } from '@assistant-ui/core/react';
import { useEffect, useRef } from 'react';

import { useAui, useAuiState } from '../assistant-ui.js';
import { useOptionalServer } from '../server/ServerContext.js';

/** The server writes its generated title shortly after a turn ends; one re-check picks it up. */
const TITLE_RECHECK_DELAY_MS = 5_000;

/**
 * After a turn ends, read `session.title` from GET /sessions/{id} and rename the
 * thread-list row when the server title is non-empty and differs. If it did not change,
 * read once more after a short delay, since the server may write its title a moment later.
 */
export function useSyncSessionTitle(): void {
  const server = useOptionalServer();
  const aui = useAui();
  const remoteId = useAuiState(s => s.threadListItem.remoteId);
  const title = useAuiState(s => s.threadListItem.title);
  const isRunning = useThreadIsRunning();
  const wasRunningRef = useRef(false);
  const titleRef = useRef(title);

  useEffect(() => {
    titleRef.current = title;
  }, [title]);

  useEffect(() => {
    const finishedTurn = wasRunningRef.current && !isRunning;
    wasRunningRef.current = isRunning;

    if (!finishedTurn || server == null || remoteId == null) {
      return;
    }

    let cancelled = false;
    let recheckTimer: ReturnType<typeof setTimeout> | undefined;

    // Resolves true when the row was renamed or the read is no longer needed.
    const syncOnce = async (): Promise<boolean> => {
      const session = await server.getSession({ sessionId: remoteId });
      if (cancelled) return true;
      const nextTitle = typeof session.title === 'string' ? session.title.trim() : '';
      const currentTitle = titleRef.current?.trim() ?? '';
      if (nextTitle.length === 0 || nextTitle === currentTitle) return false;
      await aui.threadListItem().rename(nextTitle);
      return true;
    };

    void syncOnce()
      .catch(() => false)
      .then(changed => {
        if (cancelled || changed) return;
        recheckTimer = setTimeout(() => {
          void syncOnce().catch(() => undefined);
        }, TITLE_RECHECK_DELAY_MS);
      });

    return () => {
      cancelled = true;
      clearTimeout(recheckTimer);
    };
  }, [aui, isRunning, remoteId, server]);
}

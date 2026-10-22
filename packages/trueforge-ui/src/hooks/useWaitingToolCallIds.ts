'use client';

import { useAuiState } from '@assistant-ui/react';
import { toolInvocationRawId } from '@truefoundry/assistant-ui-runtime';
import { useEffect, useState } from 'react';

import { hasSessionResync } from '../plugins/trueforge-agent-server-adapter/sessionResync.js';
import { useOptionalServer } from '../server/ServerContext.js';

/** How long to wait before reading again while the tip turn is still being saved, and how often. */
const RUNNING_TIP_RETRY_MS = 1000;
const RUNNING_TIP_MAX_READS = 10;

/**
 * Raw tool call ids the server still lists as waiting on the session tip. A card whose id is not in
 * this set belongs to a request that ended. Returns `undefined` until the server has answered for
 * the current pending cards with a settled tip, and cards keep their current behaviour until then.
 */
export function useWaitingToolCallIds(pendingApprovalIds: readonly string[]): ReadonlySet<string> | undefined {
  const server = useOptionalServer();
  const sessionId = useAuiState(state => state.threadListItem?.remoteId);
  // The read repeats whenever the set of pending cards changes, so a card that arrives after the
  // last read is never judged against an answer that predates it.
  // A card streams in before its turn is saved as paused, so nothing is judged while the chat runs.
  const isRunning = useAuiState(state => state.thread.isRunning);
  const key = `${sessionId ?? ''}\n${String(isRunning)}\n${[...pendingApprovalIds].sort().join('\n')}`;
  const [answer, setAnswer] = useState<{ key: string; ids: ReadonlySet<string> } | undefined>(undefined);

  useEffect(() => {
    if (server == null || !hasSessionResync(server) || sessionId == null || isRunning) return;
    const port = server;
    const id = sessionId;
    let current = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let reads = 0;
    async function readWaiting() {
      reads += 1;
      try {
        const tip = await port.peekSessionTip({ sessionId: id });
        if (!current) return;
        // An unsettled tip says nothing about which cards still wait, so it is read again.
        if (tip == null || tip.status === 'running') {
          if (reads < RUNNING_TIP_MAX_READS) retry = setTimeout(() => void readWaiting(), RUNNING_TIP_RETRY_MS);
          return;
        }
        const ids = new Set(tip.pendingApprovals.map(approval => toolInvocationRawId(approval.toolCallId)));
        setAnswer({ key, ids });
      } catch {
        // A failed read leaves the cards as they are; the server still refuses a stale answer.
      }
    }
    void readWaiting();
    return () => {
      current = false;
      clearTimeout(retry);
    };
  }, [server, sessionId, key, isRunning]);

  return answer?.key === key ? answer.ids : undefined;
}

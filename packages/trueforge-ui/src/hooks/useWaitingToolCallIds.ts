'use client';

import { useAuiState } from '@assistant-ui/react';
import { toolInvocationRawId } from '@truefoundry/assistant-ui-runtime';
import { useEffect, useState } from 'react';

import { hasSessionResync } from '../plugins/trueforge-agent-server-adapter/sessionResync.js';
import { useOptionalServer } from '../server/ServerContext.js';

/**
 * Raw tool call ids the server still lists as waiting on the session tip. A card whose id is not in
 * this set belongs to a request that ended. Returns `undefined` until the server has answered for
 * the current pending cards, and cards keep their current behaviour until then.
 */
export function useWaitingToolCallIds(pendingApprovalIds: readonly string[]): ReadonlySet<string> | undefined {
  const server = useOptionalServer();
  const sessionId = useAuiState(state => state.threadListItem?.remoteId);
  // The read repeats whenever the set of pending cards changes, so a card that arrives after the
  // last read is never judged against an answer that predates it.
  const key = `${sessionId ?? ''}\n${[...pendingApprovalIds].sort().join('\n')}`;
  const [answer, setAnswer] = useState<{ key: string; ids: ReadonlySet<string> } | undefined>(undefined);

  useEffect(() => {
    if (server == null || !hasSessionResync(server) || sessionId == null) return;
    const port = server;
    const id = sessionId;
    let current = true;
    async function readWaiting() {
      try {
        const tip = await port.peekSessionTip({ sessionId: id });
        if (!current) return;
        const ids = new Set((tip?.pendingApprovals ?? []).map(approval => toolInvocationRawId(approval.toolCallId)));
        setAnswer({ key, ids });
      } catch {
        // A failed read leaves the cards as they are; the server still refuses a stale answer.
      }
    }
    void readWaiting();
    return () => {
      current = false;
    };
  }, [server, sessionId, key]);

  return answer?.key === key ? answer.ids : undefined;
}

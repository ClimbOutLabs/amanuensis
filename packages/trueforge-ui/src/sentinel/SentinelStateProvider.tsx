'use client';

import { toolInvocationRawId } from '@truefoundry/assistant-ui-runtime';
import { createContext, useContext, useEffect, useMemo, useState, type FC, type ReactNode } from 'react';

import { useAuiState } from '../assistant-ui.js';

import { useOptionalSentinelApi } from './SentinelApiContext.js';
import { subscribeToSentinelEvents } from './sentinelEvents.js';
import type { SentinelApprovalInfo } from './types.js';

export type SentinelState = {
  /** Tiered approval info the server attached to a tool call, if any. */
  approvalFor: (toolCallId: string) => SentinelApprovalInfo | undefined;
};

const SentinelStateContext = createContext<SentinelState | null>(null);

/**
 * Owns per-tool-call Sentinel approval cards for the active session. Live
 * `tool.approval_required` events arrive via the module-level tap in `chatServer.ts`;
 * persisted events are read back through the host API so a reloaded tab rebuilds the
 * same cards. Mounted once in `ThreadContainer`, next to the document-ingestion provider.
 */
export const SentinelStateProvider: FC<{ children: ReactNode }> = ({ children }) => {
  const api = useOptionalSentinelApi();
  const sessionId = useAuiState(state => state.threadListItem.remoteId);
  const [approvals, setApprovals] = useState<Map<string, SentinelApprovalInfo>>(new Map());

  useEffect(() => {
    return subscribeToSentinelEvents(info => setApprovals(previous => new Map(previous).set(info.toolCallId, info)));
  }, []);

  useEffect(() => {
    setApprovals(new Map());
    if (api == null || sessionId == null) return;
    let cancelled = false;
    void api
      .listSentinelSessionContext(sessionId)
      .then(context => {
        if (cancelled) return;
        // A live card that arrived while this read was in flight is newer than what it saw, so it wins:
        // replacing the map would turn a card the user is looking at back into the generic bar.
        setApprovals(previous => {
          const merged = new Map(context.approvals.map(info => [info.toolCallId, info]));
          for (const [toolCallId, info] of previous) merged.set(toolCallId, info);
          return merged;
        });
      })
      .catch(() => {
        // Best-effort history load: live events still populate the map.
      });
    return () => {
      cancelled = true;
    };
  }, [api, sessionId]);

  const state = useMemo<SentinelState>(
    () => ({
      // Entries are keyed by the server tool call id; chat parts pass the runtime's invocation key.
      approvalFor: toolCallId => approvals.get(toolInvocationRawId(toolCallId)),
    }),
    [approvals],
  );

  return <SentinelStateContext.Provider value={state}>{children}</SentinelStateContext.Provider>;
};

/** `null` outside `SentinelStateProvider`; Sentinel UI then renders nothing. */
export function useOptionalSentinelState(): SentinelState | null {
  return useContext(SentinelStateContext);
}

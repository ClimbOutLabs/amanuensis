'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type FC,
  type ReactNode,
  type SetStateAction,
} from 'react';

import { useAuiState } from '../assistant-ui.js';

import { useOptionalSentinelApi } from './SentinelApiContext.js';
import { subscribeToSentinelEvents, type SentinelLiveEvent } from './sentinelEvents.js';
import type { SentinelApprovalInfo, Tier2Notice } from './types.js';

export type SentinelState = {
  /** Tiered approval info the server attached to a tool call, if any. */
  approvalFor: (toolCallId: string) => SentinelApprovalInfo | undefined;
  /** Tier 2 notice for a tool call, if one arrived. */
  noticeFor: (toolCallId: string) => Tier2Notice | undefined;
  undoNotice: (toolCallId: string) => Promise<void>;
  stopNotice: (toolCallId: string) => Promise<void>;
};

const SentinelStateContext = createContext<SentinelState | null>(null);

function applyLiveEvent(
  event: SentinelLiveEvent,
  setApprovals: Dispatch<SetStateAction<Map<string, SentinelApprovalInfo>>>,
  setNotices: Dispatch<SetStateAction<Map<string, Tier2Notice>>>,
): void {
  if (event.kind === 'approval') {
    const info = event.info;
    setApprovals(previous => new Map(previous).set(info.toolCallId, info));
    return;
  }
  const notice = event.notice;
  setNotices(previous => new Map(previous).set(notice.toolCallId, notice));
}

/**
 * Owns per-tool-call Sentinel state for the active session: Tier 3 approval cards and
 * Tier 2 notices. Live `tool.approval_required` / `tool.tier2_notice` events arrive via
 * the module-level tap in `chatServer.ts`; persisted events are read back through the
 * host API so a reloaded tab rebuilds the same cards and notices. Mounted once in
 * `ThreadContainer`, next to the document-ingestion provider.
 */
export const SentinelStateProvider: FC<{ children: ReactNode }> = ({ children }) => {
  const api = useOptionalSentinelApi();
  const sessionId = useAuiState(state => state.threadListItem.remoteId);
  const [approvals, setApprovals] = useState<Map<string, SentinelApprovalInfo>>(new Map());
  const [notices, setNotices] = useState<Map<string, Tier2Notice>>(new Map());

  useEffect(() => {
    return subscribeToSentinelEvents(event => applyLiveEvent(event, setApprovals, setNotices));
  }, []);

  useEffect(() => {
    setApprovals(new Map());
    setNotices(new Map());
    if (api == null || sessionId == null) return;
    let cancelled = false;
    void api
      .listSentinelSessionContext(sessionId)
      .then(context => {
        if (cancelled) return;
        setApprovals(new Map(context.approvals.map(info => [info.toolCallId, info])));
        setNotices(new Map(context.notices.map(notice => [notice.toolCallId, notice])));
      })
      .catch(() => {
        // Best-effort history load: live events still populate the maps.
      });
    return () => {
      cancelled = true;
    };
  }, [api, sessionId]);

  const undoNotice = useCallback(
    async (toolCallId: string) => {
      if (api == null || sessionId == null) return;
      const notice = notices.get(toolCallId);
      await api.undoTier2Action({
        sessionId,
        noticeId: notice?.notice_id ?? toolCallId,
      });
    },
    [api, sessionId, notices],
  );

  const stopNotice = useCallback(
    async (toolCallId: string) => {
      if (api == null || sessionId == null) return;
      const notice = notices.get(toolCallId);
      await api.stopTier2Action({
        sessionId,
        noticeId: notice?.notice_id ?? toolCallId,
      });
    },
    [api, sessionId, notices],
  );

  const state = useMemo<SentinelState>(
    () => ({
      approvalFor: toolCallId => approvals.get(toolCallId),
      noticeFor: toolCallId => notices.get(toolCallId),
      undoNotice,
      stopNotice,
    }),
    [approvals, notices, undoNotice, stopNotice],
  );

  return <SentinelStateContext.Provider value={state}>{children}</SentinelStateContext.Provider>;
};

/** `null` outside `SentinelStateProvider`; Sentinel UI then renders nothing. */
export function useOptionalSentinelState(): SentinelState | null {
  return useContext(SentinelStateContext);
}

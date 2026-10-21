'use client';

import { toolInvocationRawId } from '@truefoundry/assistant-ui-runtime';
import { createContext, useContext, useEffect, useMemo, useState, type FC, type ReactNode } from 'react';

import { useAuiState } from '../assistant-ui.js';

import { useOptionalSentinelApi } from './SentinelApiContext.js';
import { subscribeToSentinelEvents } from './sentinelEvents.js';
import type { ApprovalAnswer, SentinelApprovalInfo } from './types.js';

export type SentinelState = {
  /** Tiered approval info the server attached to a tool call, if any. */
  approvalFor: (toolCallId: string) => SentinelApprovalInfo | undefined;
  /** The card for an action a scheduled run held for the owner, if this tool call is one. */
  heldFor: (toolCallId: string) => SentinelApprovalInfo | undefined;
  /** Whether a scheduled run had to drop this tool call because it could not save it for the owner. */
  wasNotSaved: (toolCallId: string) => boolean;
  /** The owner's answer to this tool call, if one is recorded or was just given. */
  answerFor: (toolCallId: string) => ApprovalAnswer | undefined;
  /** Remembers an answer given in this tab until a reload reads it back from the server. */
  recordAnswer: (toolCallId: string, answer: ApprovalAnswer) => void;
  /** The words the owner typed with a "Change it" answer, if this tool call got one. */
  changeRequestFor: (toolCallId: string) => string | undefined;
  /** Remembers the words of a "Change it" answer given in this tab. */
  recordChangeRequest: (toolCallId: string, words: string) => void;
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
  const [answers, setAnswers] = useState<Map<string, ApprovalAnswer>>(new Map());
  const [changeRequests, setChangeRequests] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    return subscribeToSentinelEvents(info => setApprovals(previous => new Map(previous).set(info.toolCallId, info)));
  }, []);

  useEffect(() => {
    setApprovals(new Map());
    setAnswers(new Map());
    setChangeRequests(new Map());
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
        setAnswers(previous => new Map([...Object.entries(context.answers ?? {}), ...previous]));
        setChangeRequests(previous => new Map([...Object.entries(context.changeRequests ?? {}), ...previous]));
      })
      .catch((error: unknown) => {
        // Best-effort: live events still populate the map, but a failed read leaves a reloaded tab
        // with the generic approval bar, so it must not fail silently.
        console.error('Sentinel approval history could not be loaded', error);
      });
    return () => {
      cancelled = true;
    };
  }, [api, sessionId]);

  const state = useMemo<SentinelState>(
    () => ({
      // Entries are keyed by the server tool call id; chat parts pass the runtime's invocation key.
      approvalFor: toolCallId => approvals.get(toolInvocationRawId(toolCallId)),
      heldFor: toolCallId => {
        const info = approvals.get(toolInvocationRawId(toolCallId));
        return info?.held === undefined ? undefined : info;
      },
      wasNotSaved: toolCallId => approvals.get(toolInvocationRawId(toolCallId))?.notSaved !== undefined,
      answerFor: toolCallId => answers.get(toolInvocationRawId(toolCallId)),
      recordAnswer: (toolCallId, answer) =>
        setAnswers(previous => new Map(previous).set(toolInvocationRawId(toolCallId), answer)),
      changeRequestFor: toolCallId => changeRequests.get(toolInvocationRawId(toolCallId)),
      recordChangeRequest: (toolCallId, words) =>
        setChangeRequests(previous => new Map(previous).set(toolInvocationRawId(toolCallId), words)),
    }),
    [approvals, answers, changeRequests],
  );

  return <SentinelStateContext.Provider value={state}>{children}</SentinelStateContext.Provider>;
};

/** `null` outside `SentinelStateProvider`; Sentinel UI then renders nothing. */
export function useOptionalSentinelState(): SentinelState | null {
  return useContext(SentinelStateContext);
}

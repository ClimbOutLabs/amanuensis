'use client';

import { useAuiState } from '@assistant-ui/react';
import { useTrueFoundryAgentSpec } from '@truefoundry/assistant-ui-runtime';
import { useEffect, useState } from 'react';

import { useOptionalServer } from '../server/ServerContext.js';
import {
  hasSessionResync,
  type LastCompactionStatus,
} from '../plugins/trueforge-agent-server-adapter/sessionResync.js';

export type CompactionStatusResult = {
  /** Model context limit in tokens, when known from the agent spec. */
  contextLimit: number | null;
  /** Input tokens from the session's most recent turn (what the model last saw). */
  liveTokens: number | null;
  /** Most recent compaction, or null when none has run yet. */
  lastCompaction: LastCompactionStatus | null;
  loading: boolean;
};

/** Reads the model's context length from the agent spec, when present. */
function useContextLimit(): number | null {
  const { agentSpec } = useTrueFoundryAgentSpec();
  // The agent spec's model ref may carry resolved properties (including
  // contextLength) depending on the server; treat as unknown and narrow.
  const model: unknown = agentSpec?.model;
  if (typeof model !== 'object' || model === null) return null;
  const properties: unknown = (model as { properties?: unknown }).properties;
  if (typeof properties !== 'object' || properties === null) return null;
  const contextLength: unknown = (properties as { contextLength?: unknown }).contextLength;
  return typeof contextLength === 'number' && contextLength > 0 ? contextLength : null;
}

/**
 * Latest context compaction status for the active session.
 * Polls the persisted session events so the status survives page reloads;
 * refreshes whenever the session changes. Also fetches the most recent
 * turn's input tokens, which is the actual number the model saw last.
 */
export function useCompactionStatus(): CompactionStatusResult {
  const sessionId = useAuiState(state => state.threadListItem?.remoteId);
  const server = useOptionalServer();
  const contextLimit = useContextLimit();
  const [lastCompaction, setLastCompaction] = useState<LastCompactionStatus | null>(null);
  const [liveTokens, setLiveTokens] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (sessionId == null || sessionId.length === 0) {
      setLastCompaction(null);
      setLiveTokens(null);
      return;
    }
    if (server == null || !hasSessionResync(server)) return;
    let cancelled = false;
    setLoading(true);
    Promise.all([
      server.getLastCompactionStatus({ sessionId }).catch(() => null),
      server.getLastTurnInputTokens({ sessionId }).catch(() => null),
    ])
      .then(([compaction, tokens]) => {
        if (cancelled) return;
        setLastCompaction(compaction);
        setLiveTokens(tokens);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, server]);

  return { contextLimit, liveTokens, lastCompaction, loading };
}

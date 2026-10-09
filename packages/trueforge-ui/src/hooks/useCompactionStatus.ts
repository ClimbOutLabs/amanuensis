'use client';

import { useAuiState } from '@assistant-ui/react';
import { useTrueFoundryAgentSpec } from '@truefoundry/assistant-ui-runtime';
import { useEffect, useState } from 'react';

import {
  hasSessionResync,
  type LastCompactionStatus,
} from '../plugins/trueforge-agent-server-adapter/sessionResync.js';
import { useOptionalServer } from '../server/ServerContext.js';

export type CompactionStatusResult = {
  /** Model context limit in tokens, when known from the agent spec. */
  contextLimit: number | null;
  /** Input tokens from the session's most recent turn (what the model last saw). */
  liveTokens: number | null;
  /** Max output tokens reserved by the model, when known from the agent spec. */
  maxOutputTokens: number | null;
  /** Most recent compaction, or null when none has run yet. */
  lastCompaction: LastCompactionStatus | null;
  loading: boolean;
};

/** Reads numeric model properties from the agent spec, when present. */
function useModelProperties(): { contextLength: number | null; maxOutputTokens: number | null } {
  const { agentSpec } = useTrueFoundryAgentSpec();
  // The agent spec's model ref may carry resolved properties depending on
  // the server; treat as unknown and narrow.
  const model: unknown = agentSpec?.model;
  if (typeof model !== 'object' || model === null) return { contextLength: null, maxOutputTokens: null };
  const properties: unknown = (model as { properties?: unknown }).properties;
  if (typeof properties !== 'object' || properties === null) return { contextLength: null, maxOutputTokens: null };
  const props = properties as Record<string, unknown>;
  const read = (key: string): number | null => {
    const value: unknown = props[key];
    return typeof value === 'number' && value > 0 ? value : null;
  };
  return { contextLength: read('contextLength'), maxOutputTokens: read('maxOutputTokens') };
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
  const { contextLength: contextLimit, maxOutputTokens } = useModelProperties();
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

  return { contextLimit, liveTokens, maxOutputTokens, lastCompaction, loading };
}

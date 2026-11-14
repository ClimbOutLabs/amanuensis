'use client';

import { useThreadIsRunning } from '@assistant-ui/core/react';
import { useAuiState } from '@assistant-ui/react';
import { useTrueFoundryAgentSpec } from '@truefoundry/assistant-ui-runtime';
import { useEffect, useRef, useState } from 'react';

import { useDraftCatalog } from '../atoms/draft/DraftCatalogProvider.js';
import {
  hasSessionResync,
  type LastCompactionStatus,
} from '../plugins/trueforge-agent-server-adapter/sessionResync.js';
import { useOptionalServer } from '../server/ServerContext.js';

export type CompactionStatusResult = {
  /** Model context limit in tokens, when the model list knows it. */
  contextLimit: number | null;
  /** Input tokens from the session's most recent turn (what the model last saw). */
  liveTokens: number | null;
  /** Max output tokens reserved by the model, when the model list knows it. */
  maxOutputTokens: number | null;
  /** Most recent compaction, or null when none has run yet. */
  lastCompaction: LastCompactionStatus | null;
  loading: boolean;
};

/** What the chat's model can hold, read from the model list by the name the chat uses. */
function useModelProperties({ wanted }: { wanted: boolean }): {
  contextLength: number | null;
  maxOutputTokens: number | null;
} {
  const { agentSpec } = useTrueFoundryAgentSpec();
  const { models, ensureLoaded } = useDraftCatalog();
  // The chat only names its model; the limits live in the model list, which loads on demand.
  useEffect(() => {
    if (wanted) ensureLoaded();
  }, [wanted, ensureLoaded]);
  const modelName = agentSpec?.model.name;
  const properties = models.find(model => model.name === modelName)?.properties;
  const positive = (value: number | undefined): number | null => (value !== undefined && value > 0 ? value : null);
  return {
    contextLength: positive(properties?.contextLength),
    maxOutputTokens: positive(properties?.maxOutputTokens),
  };
}

/**
 * Latest context compaction status for the active session.
 * Polls the persisted session events so the status survives page reloads;
 * refreshes whenever the session changes or a turn ends. Also fetches the most recent
 * turn's input tokens, which is the actual number the model saw last.
 */
export function useCompactionStatus(): CompactionStatusResult {
  const sessionId = useAuiState(state => state.threadListItem?.remoteId);
  const server = useOptionalServer();
  const [lastCompaction, setLastCompaction] = useState<LastCompactionStatus | null>(null);
  const [liveTokens, setLiveTokens] = useState<number | null>(null);
  const { contextLength: contextLimit, maxOutputTokens } = useModelProperties({ wanted: liveTokens !== null });
  const [loading, setLoading] = useState(false);

  // A turn ending can trigger a compaction, so refresh then too, not only
  // when the session changes. Otherwise the status line stays stale until reload.
  const isRunning = useThreadIsRunning();
  const [turnEndCount, setTurnEndCount] = useState(0);
  const wasRunningRef = useRef(false);
  useEffect(() => {
    if (wasRunningRef.current && !isRunning) {
      setTurnEndCount(count => count + 1);
    }
    wasRunningRef.current = isRunning;
  }, [isRunning]);

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
      server.getLastCallInputTokens({ sessionId }).catch(() => null),
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
  }, [sessionId, server, turnEndCount]);

  return { contextLimit, liveTokens, maxOutputTokens, lastCompaction, loading };
}

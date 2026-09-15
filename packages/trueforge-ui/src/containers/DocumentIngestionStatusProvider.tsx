'use client';

import { createContext, useContext, useEffect, useState, type PropsWithChildren } from 'react';

import { useAuiState } from '../assistant-ui.js';
import {
  useOptionalDocumentIngestion,
  type DocumentIngestionFileStatus,
  type DocumentIngestionTurnContext,
} from '../components/DocumentIngestionContext.js';

const EMPTY_MAP: ReadonlyMap<string, DocumentIngestionTurnContext> = new Map();

const DocumentIngestionDataContext = createContext<ReadonlyMap<string, DocumentIngestionTurnContext>>(EMPTY_MAP);

function withFileStatus(
  files: readonly DocumentIngestionFileStatus[],
  update: DocumentIngestionFileStatus,
): DocumentIngestionFileStatus[] {
  const index = files.findIndex(file => file.fileName === update.fileName);
  if (index === -1) return [...files, update];
  return files.map((file, i) => (i === index ? update : file));
}

/**
 * Loads this session's durable document-ingestion history once (for a reloaded transcript), then
 * subscribes to `document.ingestion` events as they arrive live on the turn stream — no polling.
 * `subscribeToDocumentIngestion` pushes each `started`/terminal event the instant it is observed on
 * the SSE stream (see `chatServer.ts`), so a status line updates the moment the server yields it,
 * not on the next interval tick.
 *
 * Renders `children` unchanged when no host `DocumentIngestionProvider` is mounted, so this is a
 * no-op for hosts that do not expose Amanuensis-style ingestion progress.
 */
export function DocumentIngestionStatusProvider({ children }: PropsWithChildren) {
  const api = useOptionalDocumentIngestion();
  const sessionId = useAuiState(state => state.threadListItem.remoteId);
  const [byTurn, setByTurn] = useState<ReadonlyMap<string, DocumentIngestionTurnContext>>(EMPTY_MAP);

  useEffect(() => {
    if (api == null || sessionId == null) {
      setByTurn(EMPTY_MAP);
      return;
    }

    let cancelled = false;
    void api
      .listDocumentIngestionTurnContext(sessionId)
      .then(items => {
        if (cancelled) return;
        setByTurn(new Map(items.map(item => [item.turnId, item])));
      })
      .catch(() => {
        // Best-effort history load: a failed fetch just leaves the map empty until a live
        // event (if any) populates it.
      });

    const unsubscribe = api.subscribeToDocumentIngestion?.(event => {
      if (cancelled) return;
      setByTurn(previous => {
        const existing = previous.get(event.turnId) ?? { turnId: event.turnId, files: [] };
        const files = withFileStatus(existing.files, { fileName: event.fileName, phase: event.phase });
        const next = new Map(previous);
        next.set(event.turnId, { ...existing, files });
        return next;
      });
    });

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [api, sessionId]);

  return <DocumentIngestionDataContext.Provider value={byTurn}>{children}</DocumentIngestionDataContext.Provider>;
}

/**
 * A one-line status for the given turn while a file is still being read ("Reading <file> ..."),
 * or `undefined` once every file this turn attached has a terminal (finished/failed/cancelled)
 * event, or if none is in progress. Picks the first file still in `started` phase — attachments are
 * ingested one at a time (see `AgentThread.extractStagedDocuments`'s per-file loop), so at most one
 * is ever genuinely in progress at a time in practice.
 */
export function useDocumentIngestionStatusLine(turnId: string | undefined): string | undefined {
  const byTurn = useContext(DocumentIngestionDataContext);
  if (turnId === undefined) return undefined;
  const inProgress = byTurn.get(turnId)?.files.find(file => file.phase === 'started');
  return inProgress === undefined ? undefined : `Reading ${inProgress.fileName} ...`;
}

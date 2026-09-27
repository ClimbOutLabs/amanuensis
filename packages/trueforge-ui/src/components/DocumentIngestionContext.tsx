'use client';

import type { TrueForgeApi } from '@truefoundry/trueforge-sdk';
import { createContext, useContext, type FC, type ReactNode } from 'react';

/**
 * Latest known lifecycle phase for one attached file this turn ingested. Canonical declaration for
 * the `DocumentIngestionApi` contract below; `trueforge-agent-server-adapter` (`chatServer.ts`)
 * re-exports this same shape via a type-only import instead of restating it, same as
 * `MemoryTurnContext` above it in this file's sibling `MemoryRecallContext.tsx`.
 */
export type DocumentIngestionFileStatus = {
  fileName: string;
  phase: TrueForgeApi.DocumentIngestionEventPhase;
};

export type DocumentIngestionTurnContext = {
  turnId: string;
  files: DocumentIngestionFileStatus[];
};

export type DocumentIngestionLiveEvent = {
  turnId: string;
  fileName: string;
  phase: DocumentIngestionFileStatus['phase'];
};

export type DocumentIngestionApi = {
  /** Every `document.ingestion` event this session has recorded, folded to one entry per file, by turn. */
  listDocumentIngestionTurnContext: (sessionId: string) => Promise<DocumentIngestionTurnContext[]>;
  /**
   * Live push of `document.ingestion` events as they arrive on the turn stream, in place of a poll.
   * Optional so a host that wires only the durable read above still gets reload history, minus the
   * live "Reading <file> ..." status line while a turn is running.
   */
  subscribeToDocumentIngestion?: (listener: (event: DocumentIngestionLiveEvent) => void) => () => void;
};

const DocumentIngestionContext = createContext<DocumentIngestionApi | null>(null);

/**
 * Opt-in, same pattern as `MemoryRecallProvider`: hosts that expose Amanuensis-style document
 * ingestion progress wrap their tree in this provider. Absent it, `useOptionalDocumentIngestion`
 * returns `null` and the in-progress status line simply never renders.
 */
export const DocumentIngestionProvider: FC<{ api: DocumentIngestionApi; children: ReactNode }> = ({
  api,
  children,
}) => <DocumentIngestionContext.Provider value={api}>{children}</DocumentIngestionContext.Provider>;

export function useOptionalDocumentIngestion(): DocumentIngestionApi | null {
  return useContext(DocumentIngestionContext);
}

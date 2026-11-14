'use client';

import { useCallback, useEffect, useState } from 'react';

import {
  memoryVaultErrorMessage,
  type MemoryVaultCatalog,
  type MemoryVaultReviewNote,
} from '@/plugins/trueforge-agent-server-adapter/catalogs/memoryVaultCatalog.js';

/** An older note, and the collection it sits in. */
export type ReviewNote = MemoryVaultReviewNote & { namespace: string };

/** What the last "Mark the ticked notes as from me" did. */
export type ReviewOutcome = { markedCount: number; refused: { entryId: string; reason: string }[] };

type Cursors = Record<string, string | null>;

/**
 * The older notes a person may mark as their own, across the given collections. Notes are found when the
 * page opens and when asked for again; nothing is marked except the ids that were ticked.
 */
export function useMemoryReview({
  vault,
  namespaces,
  onMarked,
}: {
  vault: MemoryVaultCatalog | null;
  namespaces: readonly string[];
  /** Called after notes were marked, so the page reads them again. */
  onMarked: () => void;
}) {
  const [notes, setNotes] = useState<ReviewNote[]>([]);
  const [cursors, setCursors] = useState<Cursors>({});
  const [ticked, setTicked] = useState<ReadonlySet<string>>(() => new Set());
  const [outcome, setOutcome] = useState<ReviewOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const supported = vault?.listReviewNotes !== undefined && vault.markReviewNotes !== undefined;

  const load = useCallback(
    async (from: Cursors | null) => {
      if (vault?.listReviewNotes === undefined) return;
      const list = vault.listReviewNotes.bind(vault);
      const targets = namespaces.filter(namespace => from === null || from[namespace] !== null);
      const results = await Promise.allSettled(
        targets.map(async namespace => {
          const cursor = from?.[namespace] ?? undefined;
          const found = await list({
            ...(namespace === '' ? {} : { namespace }),
            ...(cursor === undefined ? {} : { cursor }),
          });
          return { namespace, found };
        }),
      );
      const loaded = results.flatMap(result => (result.status === 'fulfilled' ? [result.value] : []));
      const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      setNotes(previous => [
        ...(from === null ? [] : previous),
        ...loaded.flatMap(({ namespace, found }) => found.notes.map(note => ({ ...note, namespace }))),
      ]);
      setCursors(previous => ({
        ...(from === null ? {} : previous),
        ...Object.fromEntries(loaded.map(({ namespace, found }) => [namespace, found.nextCursor])),
      }));
      setError(failure === undefined ? null : memoryVaultErrorMessage(failure.reason));
    },
    [vault, namespaces],
  );

  useEffect(() => {
    void load(null);
  }, [load]);

  const toggle = useCallback((entryId: string) => {
    setTicked(previous => {
      const next = new Set(previous);
      if (next.has(entryId)) next.delete(entryId);
      else next.add(entryId);
      return next;
    });
  }, []);

  const tickAll = useCallback((entryIds: readonly string[]) => {
    setTicked(previous => new Set([...previous, ...entryIds]));
  }, []);

  const markTicked = useCallback(async () => {
    if (vault?.markReviewNotes === undefined || ticked.size === 0) return;
    setBusy(true);
    setError(null);
    const marked = new Set<string>();
    const refused: ReviewOutcome['refused'] = [];
    try {
      // Only the ids that were ticked are sent, a collection at a time.
      for (const namespace of namespaces) {
        const entryIds = notes
          .filter(note => note.namespace === namespace && ticked.has(note.entryId))
          .map(note => note.entryId);
        if (entryIds.length === 0) continue;
        const result = await vault.markReviewNotes({ ...(namespace === '' ? {} : { namespace }), entryIds });
        result.markedIds.forEach(id => marked.add(id));
        refused.push(...result.refused);
      }
      setOutcome({ markedCount: marked.size, refused });
      setNotes(previous => previous.filter(note => !marked.has(note.entryId)));
      setTicked(new Set());
      if (marked.size > 0) onMarked();
    } catch (markError) {
      setError(memoryVaultErrorMessage(markError));
    } finally {
      setBusy(false);
    }
  }, [vault, namespaces, notes, ticked, onMarked]);

  return {
    supported,
    notes,
    hasMore: Object.values(cursors).some(cursor => cursor !== null && cursor !== undefined),
    loadMore: () => load(cursors),
    ticked,
    toggle,
    tickAll,
    markTicked,
    outcome,
    error,
    busy,
  };
}

export type MemoryReviewState = ReturnType<typeof useMemoryReview>;

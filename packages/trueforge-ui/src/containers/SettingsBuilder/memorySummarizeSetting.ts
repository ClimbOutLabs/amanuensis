'use client';

import { useCallback, useEffect, useState } from 'react';

import type { MemorySummarizeCatalog } from '../../plugins/trueforge-agent-server-adapter/catalogs/memorySummarizeCatalog.js';
import {
  memorySummarizeErrorMessage,
  type MemorySummarizeSetting,
} from '../../plugins/trueforge-agent-server-adapter/catalogs/memorySummarizeCatalog.js';
import { useOptionalServer } from '../../server/ServerContext.js';

/**
 * Structural check: the trueforge adapter attaches a `memorySummarize` port next to the
 * runtime's `AgentUIServer` surface; other servers don't carry it. Read-only shape probe —
 * never a write — so a foreign server simply reports "not supported".
 */
function hasMemorySummarizePort(server: object): server is { memorySummarize: MemorySummarizeCatalog } {
  const port: unknown = Reflect.get(server, 'memorySummarize');
  return (
    typeof port === 'object' &&
    port !== null &&
    typeof Reflect.get(port, 'getMemorySummarize') === 'function' &&
    typeof Reflect.get(port, 'setMemorySummarizeEnabled') === 'function'
  );
}

export interface MemorySummarizeSettingState {
  /** Whether this server carries the trueforge turn-summarization port. */
  supported: boolean;
  /**
   * The stored setting (persisted override else env default). A write flips this
   * optimistically and rolls it back to the last confirmed value if the write fails;
   * before any write it comes from the initial GET, so the switch never waits on a
   * round-trip to reflect a flip. `null` until the first GET settles.
   */
  enabled: boolean | null;
  /**
   * What the server will actually do for the next turn — the truth the toggle shows.
   * On the markdown backend this equals `enabled`; on any other backend it is false
   * even when the stored setting is on. `null` until the first GET settles.
   */
  effectiveEnabled: boolean | null;
  /** Whether a persisted override is stored; `null` until the first successful GET. */
  overridden: boolean | null;
  /** The `MEMORY_SUMMARIZE` env default; `null` until the first successful GET. */
  defaultEnabled: boolean | null;
  saving: boolean;
  error: string | null;
  /** Persists the override (`true`/`false`); resolves when saved, rejects on failure. */
  setEnabled(enabled: boolean): Promise<void>;
  /** Clears the override back to the server default; resolves when saved, rejects on failure. */
  clearOverride(): Promise<void>;
}

/**
 * The live turn-summarization switch state. Reads the stored setting once via the
 * catalog port; writes go straight through. Unlike screening there is no external
 * service to be (un)configured, so on the markdown backend the stored value is the
 * effective value — the toggle shows `effectiveEnabled`, what the server will
 * actually do, so what you see is the truth.
 */
export function useMemorySummarizeSetting(): MemorySummarizeSettingState {
  const server = useOptionalServer();

  const catalog = server !== null && hasMemorySummarizePort(server) ? server.memorySummarize : null;

  const [stored, setStored] = useState<MemorySummarizeSetting | null>(null);
  /**
   * Optimistic value shown while a write is in flight. Cleared on success (the server
   * response takes over) and on failure (the switch rolls back to the last confirmed
   * value), so the control flips instantly on every tap.
   */
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (catalog === null) return;
    let cancelled = false;
    void catalog.getMemorySummarize().then(
      next => {
        if (!cancelled) setStored(next);
      },
      () => {
        // Leave the override state unknown: the reset link stays hidden, but the switch
        // still works off the last confirmed value and writes still go through.
      },
    );
    return () => {
      cancelled = true;
    };
  }, [catalog]);

  const write = useCallback(
    async (next: boolean | null) => {
      if (catalog === null) return;
      // For a clear, the value that lands is the env default; fall back to the last
      // confirmed effective state when the default isn't known yet.
      const optimisticValue = next ?? stored?.defaultEnabled ?? stored?.enabled ?? null;
      setOptimistic(optimisticValue);
      setSaving(true);
      setError(null);
      try {
        const updated = await catalog.setMemorySummarizeEnabled(next);
        setStored(updated);
        setOptimistic(null);
      } catch (caught) {
        setOptimistic(null);
        const message = memorySummarizeErrorMessage(caught);
        setError(message);
        throw new Error(message, { cause: caught });
      } finally {
        setSaving(false);
      }
    },
    [catalog, stored],
  );

  const enabled = optimistic ?? stored?.enabled ?? null;
  // The backend gate is server config: it cannot change mid-write, and the switch is
  // disabled whenever the gate blocks, so the optimistic effective value follows the
  // optimistic stored value the same way the last confirmed pair did.
  const effectiveEnabled = optimistic ?? stored?.effectiveEnabled ?? null;

  return {
    supported: catalog !== null,
    enabled,
    effectiveEnabled,
    overridden: stored === null ? null : stored.overridden,
    defaultEnabled: stored === null ? null : stored.defaultEnabled,
    saving,
    error,
    setEnabled: next => write(next),
    clearOverride: () => write(null),
  };
}

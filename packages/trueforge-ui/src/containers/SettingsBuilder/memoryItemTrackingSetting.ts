'use client';

import { useCallback, useEffect, useState } from 'react';

import type { MemoryItemTrackingCatalog } from '../../plugins/trueforge-agent-server-adapter/catalogs/memoryItemTrackingCatalog.js';
import {
  memoryItemTrackingErrorMessage,
  type MemoryItemTrackingSetting,
} from '../../plugins/trueforge-agent-server-adapter/catalogs/memoryItemTrackingCatalog.js';
import { useOptionalServer } from '../../server/ServerContext.js';

/**
 * Structural check: the trueforge adapter attaches a `memoryItemTracking` port next to the
 * runtime's `AgentUIServer` surface; other servers don't carry it. Read-only shape probe —
 * never a write — so a foreign server simply reports "not supported".
 */
function hasMemoryItemTrackingPort(server: object): server is { memoryItemTracking: MemoryItemTrackingCatalog } {
  const port: unknown = Reflect.get(server, 'memoryItemTracking');
  return (
    typeof port === 'object' &&
    port !== null &&
    typeof Reflect.get(port, 'getMemoryItemTracking') === 'function' &&
    typeof Reflect.get(port, 'setMemoryItemTrackingEnabled') === 'function'
  );
}

export interface MemoryItemTrackingSettingState {
  /** Whether this server carries the trueforge item-tracking port. */
  supported: boolean;
  /**
   * The stored setting (persisted override else the default). A write flips this
   * optimistically and rolls it back to the last confirmed value if the write fails;
   * before any write it comes from the initial GET, so the switch never waits on a
   * round-trip to reflect a flip. `null` until the first GET settles.
   */
  enabled: boolean | null;
  /** Whether a persisted override is stored; `null` until the first successful GET. */
  overridden: boolean | null;
  /** The default (on); `null` until the first successful GET. */
  defaultEnabled: boolean | null;
  saving: boolean;
  error: string | null;
  /** Persists the override (`true`/`false`); resolves when saved, rejects on failure. */
  setEnabled(enabled: boolean): Promise<void>;
  /** Clears the override back to the default; resolves when saved, rejects on failure. */
  clearOverride(): Promise<void>;
}

/**
 * The live item-tracking switch state. Reads the stored setting once via the
 * catalog port; writes go straight through.
 */
export function useMemoryItemTrackingSetting(): MemoryItemTrackingSettingState {
  const server = useOptionalServer();

  const catalog = server !== null && hasMemoryItemTrackingPort(server) ? server.memoryItemTracking : null;

  const [stored, setStored] = useState<MemoryItemTrackingSetting | null>(null);
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
    void catalog.getMemoryItemTracking().then(
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
      // For a clear, the value that lands is the default; fall back to the last
      // confirmed state when the default isn't known yet.
      const optimisticValue = next ?? stored?.defaultEnabled ?? stored?.enabled ?? null;
      setOptimistic(optimisticValue);
      setSaving(true);
      setError(null);
      try {
        const updated = await catalog.setMemoryItemTrackingEnabled(next);
        setStored(updated);
        setOptimistic(null);
      } catch (caught) {
        setOptimistic(null);
        const message = memoryItemTrackingErrorMessage(caught);
        setError(message);
        throw new Error(message, { cause: caught });
      } finally {
        setSaving(false);
      }
    },
    [catalog, stored],
  );

  const enabled = optimistic ?? stored?.enabled ?? null;

  return {
    supported: catalog !== null,
    enabled,
    overridden: stored === null ? null : stored.overridden,
    defaultEnabled: stored === null ? null : stored.defaultEnabled,
    saving,
    error,
    setEnabled: next => write(next),
    clearOverride: () => write(null),
  };
}

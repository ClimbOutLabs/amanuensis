'use client';

import { useCallback, useEffect, useState } from 'react';

import type { MemoryScreenCatalog } from '../../plugins/trueforge-agent-server-adapter/catalogs/memoryScreenCatalog.js';
import {
  memoryScreenErrorMessage,
  type MemoryScreenSetting,
} from '../../plugins/trueforge-agent-server-adapter/catalogs/memoryScreenCatalog.js';
import {
  useOptionalRefreshServerCapabilities,
  useOptionalServer,
  useServerCapabilities,
} from '../../server/ServerContext.js';
import { readMemoryScreenStatus } from './memoryScreenCapability.js';

/**
 * Structural check: the trueforge adapter attaches a `memoryScreen` port next to the
 * runtime's `AgentUIServer` surface; other servers don't carry it. Read-only shape probe —
 * never a write — so a foreign server simply reports "not supported".
 */
function hasMemoryScreenPort(server: object): server is { memoryScreen: MemoryScreenCatalog } {
  const port: unknown = Reflect.get(server, 'memoryScreen');
  return (
    typeof port === 'object' &&
    port !== null &&
    typeof Reflect.get(port, 'getMemoryScreen') === 'function' &&
    typeof Reflect.get(port, 'setMemoryScreenEnabled') === 'function'
  );
}

export interface MemoryScreenSettingState {
  /** Whether this server carries the trueforge recall screen port. */
  supported: boolean;
  /**
   * Effective on/off. A write flips this optimistically and rolls it back to the last
   * confirmed value if the write fails; before any write it comes from the initial
   * GET (or the capabilities flag), so the switch never waits on a round-trip to
   * reflect a flip. When the screening service is unconfigured the stored setting is
   * inert, so the capabilities' effective value (off) wins over the stored value.
   * `null` until the first source settles.
   */
  enabled: boolean | null;
  /** Whether a persisted override is stored; `null` until the first successful GET. */
  overridden: boolean | null;
  /** The `MEMORY_SCREEN_ENABLED` env default; `null` until the first successful GET. */
  defaultEnabled: boolean | null;
  saving: boolean;
  error: string | null;
  /** Persists the override (`true`/`false`); resolves when saved, rejects on failure. */
  setEnabled(enabled: boolean): Promise<void>;
  /** Clears the override back to the server default; resolves when saved, rejects on failure. */
  clearOverride(): Promise<void>;
}

/**
 * The live recall screen switch state. Reads the stored override once (capabilities
 * already carry the effective on/off instantly); writes go straight through, then
 * refresh capabilities so the card's status line converges.
 */
export function useMemoryScreenSetting(): MemoryScreenSettingState {
  const server = useOptionalServer();
  const capabilities = useServerCapabilities();
  const refreshCapabilities = useOptionalRefreshServerCapabilities();

  const catalog = server !== null && hasMemoryScreenPort(server) ? server.memoryScreen : null;

  const capabilityStatus = readMemoryScreenStatus(capabilities);
  const [stored, setStored] = useState<MemoryScreenSetting | null>(null);
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
    void catalog.getMemoryScreen().then(
      next => {
        if (!cancelled) setStored(next);
      },
      () => {
        // Leave the override state unknown: the reset link stays hidden, but the switch
        // still works off the capabilities flag and writes still go through.
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
        const updated = await catalog.setMemoryScreenEnabled(next);
        setStored(updated);
        setOptimistic(null);
        refreshCapabilities?.();
      } catch (caught) {
        setOptimistic(null);
        const message = memoryScreenErrorMessage(caught);
        setError(message);
        throw new Error(message, { cause: caught });
      } finally {
        setSaving(false);
      }
    },
    [catalog, refreshCapabilities, stored],
  );

  /**
   * When the screening service is unconfigured the stored setting is inert: the backend
   * resolver ANDs `configured` into the effective state, so `enabled` must fall through
   * to the capabilities' effective value (off) instead of a stale stored ON. Optimistic
   * writes still take precedence — they only exist while the user just acted.
   */
  const unconfigured = capabilityStatus?.configured === false;
  const confirmedEnabled = unconfigured ? capabilityStatus?.enabled : (stored?.enabled ?? capabilityStatus?.enabled);
  const enabled = optimistic ?? confirmedEnabled ?? null;

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

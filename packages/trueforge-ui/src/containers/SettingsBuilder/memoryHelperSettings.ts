'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  memoryHelperErrorMessage,
  type MemoryNightlyCatalog,
  type MemoryNightlySetting,
  type MemoryPageSortingCatalog,
  type MemoryPageSortingSetting,
  type PageSortMode,
} from '../../plugins/trueforge-agent-server-adapter/catalogs/memoryHelpersCatalog.js';
import { useOptionalServer } from '../../server/ServerContext.js';

/** Structural probe: only the trueforge adapter carries these ports, so a foreign server reports "not supported". */
function isPageSortingCatalog(port: unknown): port is MemoryPageSortingCatalog {
  return (
    typeof port === 'object' &&
    port !== null &&
    typeof Reflect.get(port, 'getMemoryPageSorting') === 'function' &&
    typeof Reflect.get(port, 'setMemoryPageSortingMode') === 'function'
  );
}

function isNightlyCatalog(port: unknown): port is MemoryNightlyCatalog {
  return (
    typeof port === 'object' &&
    port !== null &&
    typeof Reflect.get(port, 'getMemoryNightly') === 'function' &&
    typeof Reflect.get(port, 'setMemoryNightlyEnabled') === 'function'
  );
}

/** One stored setting that is read once and written on each change; the choice shows at once and rolls back on failure. */
function useStoredSetting<Stored, Value>({
  load,
  save,
  valueOf,
}: {
  load: (() => Promise<Stored>) | null;
  save: ((next: Value) => Promise<Stored>) | null;
  valueOf: (stored: Stored) => Value;
}) {
  const [stored, setStored] = useState<Stored | null>(null);
  const [pending, setPending] = useState<Value | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (load === null) return;
    let cancelled = false;
    void load().then(
      next => {
        if (!cancelled) setStored(next);
      },
      () => {
        // The control stays unavailable; nothing was changed.
      },
    );
    return () => {
      cancelled = true;
    };
  }, [load]);

  const change = useCallback(
    async (next: Value): Promise<boolean> => {
      if (save === null) return false;
      setPending(next);
      setSaving(true);
      setError(null);
      try {
        setStored(await save(next));
        return true;
      } catch (caught) {
        setError(memoryHelperErrorMessage(caught));
        return false;
      } finally {
        setPending(null);
        setSaving(false);
      }
    },
    [save],
  );

  return { stored, value: pending ?? (stored === null ? null : valueOf(stored)), saving, error, change };
}

export interface MemoryPageSortingState {
  supported: boolean;
  /** What the server will do; `null` until it has answered. Shows `off` on a server without Markdown memory. */
  mode: PageSortMode | null;
  saving: boolean;
  error: string | null;
  /** Resolves true when saved, false when the save failed (the error is then in `error`). */
  setMode(mode: PageSortMode): Promise<boolean>;
}

export function useMemoryPageSortingSetting(): MemoryPageSortingState {
  const server = useOptionalServer();
  const port: unknown = server === null ? undefined : Reflect.get(server, 'memoryPageSorting');
  const catalog = isPageSortingCatalog(port) ? port : null;
  const load = useMemo(() => (catalog === null ? null : () => catalog.getMemoryPageSorting()), [catalog]);
  const save = useMemo(
    () => (catalog === null ? null : (mode: PageSortMode) => catalog.setMemoryPageSortingMode(mode)),
    [catalog],
  );
  const state = useStoredSetting<MemoryPageSortingSetting, PageSortMode>({
    load,
    save,
    valueOf: stored => stored.effectiveMode,
  });
  return {
    supported: catalog !== null,
    mode: state.value,
    saving: state.saving,
    error: state.error,
    setMode: state.change,
  };
}

export interface MemoryNightlyState {
  supported: boolean;
  /** What the server will do; `null` until it has answered. */
  enabled: boolean | null;
  saving: boolean;
  error: string | null;
  /** Resolves true when saved, false when the save failed (the error is then in `error`). */
  setEnabled(enabled: boolean): Promise<boolean>;
}

export function useMemoryNightlySetting(): MemoryNightlyState {
  const server = useOptionalServer();
  const port: unknown = server === null ? undefined : Reflect.get(server, 'memoryNightly');
  const catalog = isNightlyCatalog(port) ? port : null;
  const load = useMemo(() => (catalog === null ? null : () => catalog.getMemoryNightly()), [catalog]);
  const save = useMemo(
    () => (catalog === null ? null : (enabled: boolean) => catalog.setMemoryNightlyEnabled(enabled)),
    [catalog],
  );
  const state = useStoredSetting<MemoryNightlySetting, boolean>({
    load,
    save,
    valueOf: stored => stored.effectiveEnabled,
  });
  return {
    supported: catalog !== null,
    enabled: state.value,
    saving: state.saving,
    error: state.error,
    setEnabled: state.change,
  };
}

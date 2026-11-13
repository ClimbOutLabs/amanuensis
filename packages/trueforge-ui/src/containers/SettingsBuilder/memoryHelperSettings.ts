'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  memoryHelperErrorMessage,
  type MemoryNightlyCatalog,
  type MemoryNightlySetting,
  type MemoryPageSortingCatalog,
  type MemoryPageSortingSetting,
  type MemoryTidyRun,
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
    typeof Reflect.get(port, 'setMemoryNightly') === 'function' &&
    typeof Reflect.get(port, 'tidyMemoryNow') === 'function' &&
    typeof Reflect.get(port, 'getMemoryTidyState') === 'function'
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
  /** The stored mode; `null` until the server has answered. */
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
    valueOf: stored => stored.mode,
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
  /** The stored setting; `null` until the server has answered. */
  enabled: boolean | null;
  /** The hour of the day the tidy-up starts at, 0 to 23; `null` until the server has answered. */
  hour: number | null;
  saving: boolean;
  error: string | null;
  /** Resolves true when saved, false when the save failed (the error is then in `error`). */
  setEnabled(enabled: boolean): Promise<boolean>;
  setHour(hour: number): Promise<boolean>;
  /** True while a tidy-up is running, also one started before this page was opened. */
  tidying: boolean;
  /** What the last tidy-up did, if it finished within the hour; `null` otherwise and while one runs. */
  tidied: MemoryTidyRun | null;
  tidyError: string | null;
  /** Resolves with what the tidy-up did, or `null` when it could not run (the reason is then in `tidyError`). */
  tidyNow(): Promise<MemoryTidyRun | null>;
}

/** How often a page waiting on a running tidy-up asks whether it has finished. */
const TIDY_STATE_ASK_MS = 5000;

type NightlyChange = { enabled?: boolean; hour?: number };

export function useMemoryNightlySetting(): MemoryNightlyState {
  const server = useOptionalServer();
  const port: unknown = server === null ? undefined : Reflect.get(server, 'memoryNightly');
  const catalog = isNightlyCatalog(port) ? port : null;
  const load = useMemo(() => (catalog === null ? null : () => catalog.getMemoryNightly()), [catalog]);
  const save = useMemo(
    () => (catalog === null ? null : (change: NightlyChange) => catalog.setMemoryNightly(change)),
    [catalog],
  );
  // While a change is being saved, `value` holds only the changed field; the other one is read from what is stored.
  const state = useStoredSetting<MemoryNightlySetting, NightlyChange>({
    load,
    save,
    valueOf: stored => ({ enabled: stored.enabled, hour: stored.hour }),
  });
  const [tidying, setTidying] = useState(false);
  const [tidied, setTidied] = useState<MemoryTidyRun | null>(null);
  const [tidyError, setTidyError] = useState<string | null>(null);
  // A tidy-up goes on after the page is left, so a page that opens asks where one stands and waits for it.
  useEffect(() => {
    if (catalog === null) return undefined;
    let left = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = async (): Promise<void> => {
      let state: MemoryTidyRun;
      try {
        state = await catalog.getMemoryTidyState();
      } catch {
        return;
      }
      if (left) return;
      if (state.status === 'busy') {
        setTidying(true);
        timer = setTimeout(() => void ask(), TIDY_STATE_ASK_MS);
        return;
      }
      setTidying(false);
      if (state.status === 'ran') setTidied(state);
    };
    void ask();
    return () => {
      left = true;
      clearTimeout(timer);
    };
  }, [catalog]);
  const tidyNow = useCallback(async () => {
    if (catalog === null) return null;
    setTidying(true);
    setTidied(null);
    setTidyError(null);
    try {
      const run = await catalog.tidyMemoryNow();
      setTidied(run);
      return run;
    } catch (caught) {
      setTidyError(memoryHelperErrorMessage(caught));
      return null;
    } finally {
      setTidying(false);
    }
  }, [catalog]);
  const { change } = state;
  return {
    supported: catalog !== null,
    enabled: state.value?.enabled ?? state.stored?.enabled ?? null,
    hour: state.value?.hour ?? state.stored?.hour ?? null,
    saving: state.saving,
    error: state.error,
    setEnabled: enabled => change({ enabled }),
    setHour: hour => change({ hour }),
    tidying,
    tidied,
    tidyError,
    tidyNow,
  };
}

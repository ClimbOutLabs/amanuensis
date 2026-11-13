'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

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
  /** Minutes one sorting or tidying question may wait for the model; `null` until the server has answered. */
  modelWaitMinutes: number | null;
  setModelWaitMinutes(minutes: number): Promise<boolean>;
  /** True while a tidy-up is running, also one started before this page was opened. */
  tidying: boolean;
  /** What the last tidy-up did, if it finished within the hour; `null` otherwise and while one runs. */
  tidied: MemoryTidyRun | null;
  tidyError: string | null;
  /** Starts a tidy-up and resolves when it has ended: with what it did, or `null` when it could not finish (the reason is then in `tidyError`). */
  tidyNow(): Promise<MemoryTidyRun | null>;
}

/** How often a page waiting on a running tidy-up asks whether it has finished. */
const TIDY_STATE_ASK_MS = 5000;

type NightlyChange = { enabled?: boolean; hour?: number; modelWaitMinutes?: number };

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
    valueOf: stored => ({ enabled: stored.enabled, hour: stored.hour, modelWaitMinutes: stored.modelWaitMinutes }),
  });
  const [tidying, setTidying] = useState(false);
  const [tidied, setTidied] = useState<MemoryTidyRun | null>(null);
  const [tidyError, setTidyError] = useState<string | null>(null);
  const left = useRef(false);
  // A tidy-up outlasts a web request and goes on after the page is left, so the page asks where it stands until it ends.
  const followTidy = useCallback(
    async ({ started }: { started: boolean }): Promise<MemoryTidyRun | null> => {
      if (catalog === null) return null;
      let waiting = started;
      for (;;) {
        let state: MemoryTidyRun | undefined;
        try {
          state = await catalog.getMemoryTidyState();
        } catch (caught) {
          if (!waiting) return null;
          if (!(caught instanceof TypeError)) {
            setTidying(false);
            setTidyError(memoryHelperErrorMessage(caught));
            return null;
          }
          // The server could not be reached for a moment; the tidy-up goes on there, so keep asking.
        }
        if (left.current) return null;
        if (state?.status === 'ran') {
          setTidying(false);
          setTidied(state);
          return state;
        }
        if (state?.status === 'failed') {
          setTidying(false);
          setTidyError(
            'The tidy-up stopped because something went wrong. Your pages are as they were. Choose Tidy now to try again.',
          );
          return null;
        }
        if (state?.status === 'idle') {
          if (waiting) {
            setTidying(false);
            setTidyError(
              'The tidy-up stopped before it finished, because the app restarted. Choose Tidy now to start it again.',
            );
          }
          return null;
        }
        waiting = true;
        setTidying(true);
        await new Promise(resolve => setTimeout(resolve, TIDY_STATE_ASK_MS));
        if (left.current) return null;
      }
    },
    [catalog],
  );
  useEffect(() => {
    left.current = false;
    void followTidy({ started: false });
    return () => {
      left.current = true;
    };
  }, [followTidy]);
  const tidyNow = useCallback(async () => {
    if (catalog === null) return null;
    setTidying(true);
    setTidied(null);
    setTidyError(null);
    try {
      await catalog.tidyMemoryNow();
    } catch (caught) {
      setTidyError(memoryHelperErrorMessage(caught));
      setTidying(false);
      return null;
    }
    return followTidy({ started: true });
  }, [catalog, followTidy]);
  const { change } = state;
  return {
    supported: catalog !== null,
    enabled: state.value?.enabled ?? state.stored?.enabled ?? null,
    hour: state.value?.hour ?? state.stored?.hour ?? null,
    saving: state.saving,
    error: state.error,
    setEnabled: enabled => change({ enabled }),
    setHour: hour => change({ hour }),
    modelWaitMinutes: state.value?.modelWaitMinutes ?? state.stored?.modelWaitMinutes ?? null,
    setModelWaitMinutes: modelWaitMinutes => change({ modelWaitMinutes }),
    tidying,
    tidied,
    tidyError,
    tidyNow,
  };
}

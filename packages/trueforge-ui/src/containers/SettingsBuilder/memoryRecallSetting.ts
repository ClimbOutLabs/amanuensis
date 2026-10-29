'use client';

import { useCallback, useEffect, useState } from 'react';

import {
  memoryRecallErrorMessage,
  type MemoryRecallCatalog,
  type MemoryRecallSetting,
} from '../../plugins/trueforge-agent-server-adapter/catalogs/memoryRecallCatalog.js';
import { useOptionalServer } from '../../server/ServerContext.js';

/** Read-only shape probe: other servers carry no `memoryRecall` port and report "not supported". */
function hasMemoryRecallPort(server: object): server is { memoryRecall: MemoryRecallCatalog } {
  const port: unknown = Reflect.get(server, 'memoryRecall');
  return (
    typeof port === 'object' &&
    port !== null &&
    typeof Reflect.get(port, 'getMemoryRecall') === 'function' &&
    typeof Reflect.get(port, 'setMemoryRecallEnabled') === 'function'
  );
}

export interface MemoryRecallSettingState {
  supported: boolean;
  /** The stored switch; `null` while loading or when it was never set. */
  enabled: boolean | null;
  saving: boolean;
  error: string | null;
  setEnabled(enabled: boolean): Promise<void>;
}

/**
 * The person-level "use memories in replies" switch. The server owns it and applies it to every
 * chat, including chats with a saved agent. A flip shows at once and rolls back if the save fails.
 */
export function useMemoryRecallSetting(): MemoryRecallSettingState {
  const server = useOptionalServer();
  const catalog = server !== null && hasMemoryRecallPort(server) ? server.memoryRecall : null;

  const [stored, setStored] = useState<MemoryRecallSetting | null>(null);
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (catalog === null) return;
    let cancelled = false;
    void catalog.getMemoryRecall().then(
      next => {
        if (!cancelled) setStored(next);
      },
      () => {
        // Unknown stays unknown: the switch then shows the agent's own setting.
      },
    );
    return () => {
      cancelled = true;
    };
  }, [catalog]);

  const setEnabled = useCallback(
    async (next: boolean) => {
      if (catalog === null) return;
      setOptimistic(next);
      setSaving(true);
      setError(null);
      try {
        setStored(await catalog.setMemoryRecallEnabled(next));
      } catch (caught) {
        const message = memoryRecallErrorMessage(caught);
        setError(message);
        throw new Error(message, { cause: caught });
      } finally {
        setOptimistic(null);
        setSaving(false);
      }
    },
    [catalog],
  );

  return {
    supported: catalog !== null,
    enabled: optimistic ?? stored?.enabled ?? null,
    saving,
    error,
    setEnabled,
  };
}

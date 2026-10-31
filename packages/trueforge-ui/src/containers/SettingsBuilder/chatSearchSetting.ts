'use client';

import { useCallback, useEffect, useState } from 'react';

import {
  chatSearchErrorMessage,
  type ChatSearchCatalog,
  type ChatSearchSetting,
} from '../../plugins/trueforge-agent-server-adapter/catalogs/chatSearchCatalog.js';
import { useOptionalServer } from '../../server/ServerContext.js';

/** Read-only shape probe: other servers carry no `chatSearch` port and report "not supported". */
function hasChatSearchPort(server: object): server is { chatSearch: ChatSearchCatalog } {
  const port: unknown = Reflect.get(server, 'chatSearch');
  return (
    typeof port === 'object' &&
    port !== null &&
    typeof Reflect.get(port, 'getChatSearch') === 'function' &&
    typeof Reflect.get(port, 'setChatSearchEnabled') === 'function'
  );
}

export interface ChatSearchSettingState {
  supported: boolean;
  /** The stored switch; `null` while it is still loading. Off until the person turns it on. */
  enabled: boolean | null;
  saving: boolean;
  error: string | null;
  setEnabled(enabled: boolean): Promise<void>;
}

/**
 * The person's past-chat search switch. The server owns it and applies it to every chat:
 * while it is off, the search tool is not offered at all. A flip shows at once and rolls
 * back if the save fails.
 */
export function useChatSearchSetting(): ChatSearchSettingState {
  const server = useOptionalServer();
  const catalog = server !== null && hasChatSearchPort(server) ? server.chatSearch : null;

  const [stored, setStored] = useState<ChatSearchSetting | null>(null);
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (catalog === null) return;
    let cancelled = false;
    void catalog.getChatSearch().then(
      next => {
        if (!cancelled) setStored(next);
      },
      () => {
        // Unknown stays unknown: the switch then shows off, the safe reading.
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
        setStored(await catalog.setChatSearchEnabled(next));
      } catch (caught) {
        const message = chatSearchErrorMessage(caught);
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

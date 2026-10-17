'use client';

import { useCallback, useEffect, useState } from 'react';

import type {
  TokenFactoryUsage,
  TokenFactoryUsageCatalog,
} from '../../plugins/trueforge-agent-server-adapter/catalogs/tokenFactoryUsageCatalog.js';
import { useOptionalServer } from '../../server/ServerContext.js';
import { getErrorMessage } from '../../utils/getErrorMessage.js';

/**
 * Structural check: the trueforge adapter attaches a `tokenFactoryUsage` port next to the
 * runtime's `AgentUIServer` surface; other servers don't carry it. Read-only shape probe, so a
 * foreign server simply reports "not supported".
 */
function hasTokenFactoryUsagePort(server: object): server is { tokenFactoryUsage: TokenFactoryUsageCatalog } {
  const port: unknown = Reflect.get(server, 'tokenFactoryUsage');
  return typeof port === 'object' && port !== null && typeof Reflect.get(port, 'getTokenFactoryUsage') === 'function';
}

export interface TokenFactoryUsageState {
  /** Whether this server carries the Token Factory usage port. */
  supported: boolean;
  /** Today's counters; null until the first read settles, or when it failed. */
  usage: TokenFactoryUsage | null;
  loading: boolean;
  error: string | null;
  refresh(): void;
}

/** Today's Token Factory tokens and cost per model, and the daily cap remaining. */
export function useTokenFactoryUsage(): TokenFactoryUsageState {
  const server = useOptionalServer();
  const catalog = server !== null && hasTokenFactoryUsagePort(server) ? server.tokenFactoryUsage : null;
  const [usage, setUsage] = useState<TokenFactoryUsage | null>(null);
  const [loading, setLoading] = useState(catalog !== null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (catalog === null) return;
    let cancelled = false;
    setLoading(true);
    void catalog.getTokenFactoryUsage().then(
      next => {
        if (cancelled) return;
        setUsage(next);
        setError(null);
        setLoading(false);
      },
      (caught: unknown) => {
        if (cancelled) return;
        setError(getErrorMessage(caught, "Today's Token Factory usage could not be loaded"));
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [catalog, reload]);

  const refresh = useCallback(() => {
    setReload(count => count + 1);
  }, []);

  return { supported: catalog !== null, usage, loading, error, refresh };
}

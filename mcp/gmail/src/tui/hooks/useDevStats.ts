// Live process snapshot for the `:stats` overlay. Polls snapshotHealth + the
// session counters once per tick (default 1Hz). Cheap — heap / RSS / event
// loop p99 come from existing watchdog state and a single process.memoryUsage().

import { type HealthSnapshot, snapshotHealth } from "@george43g/robustness";
import { useEffect, useState } from "react";
import { getRecentErrorCount, getToolCallCount } from "../../core/session.js";

export interface DevStats {
  health: HealthSnapshot;
  renderCount: number;
  themeName: string;
  editor: string;
  cacheBytes: number;
  cacheEntries: number;
}

export interface UseDevStatsOpts {
  /** Polling interval (ms). Defaults to 1000. */
  intervalMs?: number;
  /** Whether to actually poll — toggled by the modal open/closed state. */
  enabled: boolean;
  /** Bytes + entries the App's caches contribute. */
  cache: () => { entries: number; bytes: number };
  themeName: string;
  editor: string;
}

export function useDevStats(opts: UseDevStatsOpts): DevStats | null {
  const [snap, setSnap] = useState<DevStats | null>(null);

  useEffect(() => {
    if (!opts.enabled) {
      setSnap(null);
      return;
    }
    let cancelled = false;
    let n = 0;
    const tick = () => {
      if (cancelled) return;
      const health = snapshotHealth({
        toolCalls: getToolCallCount(),
        recentErrors: getRecentErrorCount(),
      });
      const cacheStats = opts.cache();
      n += 1;
      setSnap({
        health,
        renderCount: n,
        themeName: opts.themeName,
        editor: opts.editor,
        cacheBytes: cacheStats.bytes,
        cacheEntries: cacheStats.entries,
      });
    };
    tick();
    const id = setInterval(tick, opts.intervalMs ?? 1000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [opts.enabled, opts.themeName, opts.editor, opts.intervalMs, opts.cache]);

  return snap;
}

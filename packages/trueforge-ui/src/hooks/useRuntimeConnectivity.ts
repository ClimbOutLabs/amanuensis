'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export type RuntimeConnectivityStatus = 'ready' | 'connecting' | 'degraded' | 'offline';

export type UseRuntimeConnectivityOptions = {
  /** When false, no probing happens and status stays 'ready'. Defaults to true. */
  enabled?: boolean;
  /** Health endpoint path, same-origin. Defaults to '/healthz'. */
  healthPath?: string;
  /** Interval between background probes in ms. Defaults to 60_000. */
  probeIntervalMs?: number;
  /** Fetch timeout in ms. Defaults to 5_000. */
  probeTimeoutMs?: number;
  /** Latency above this is 'degraded'. Defaults to 2_000 ms. */
  slowProbeMs?: number;
};

export type RuntimeConnectivity = {
  status: RuntimeConnectivityStatus;
  /** Last measured round-trip in ms, or null if no successful probe yet. */
  latencyMs: number | null;
  /** Re-run the probe immediately. */
  retry: () => void;
};

/**
 * Probes the runtime's same-origin health endpoint and reports connectivity.
 * - `ready`: last probe succeeded fast.
 * - `degraded`: last probe succeeded but was slow, or a previous probe failed.
 * - `connecting`: a probe is in flight and we've never succeeded.
 * - `offline`: the last probe failed and we've never succeeded.
 *
 * Failure memory is kept in a ref so a manual retry doesn't lose the
 * degraded signal when the effect re-runs.
 */
export function useRuntimeConnectivity({
  enabled = true,
  healthPath = '/healthz',
  probeIntervalMs = 60_000,
  probeTimeoutMs = 5_000,
  slowProbeMs = 2_000,
}: UseRuntimeConnectivityOptions = {}): RuntimeConnectivity {
  const [status, setStatus] = useState<RuntimeConnectivityStatus>(enabled ? 'connecting' : 'ready');
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [probeNonce, setProbeNonce] = useState(0);
  const sawFailureRef = useRef(false);
  const inFlightRef = useRef(false);

  const probe = useCallback(async () => {
    if (typeof window === 'undefined' || typeof fetch !== 'function') return;
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    const startedAt = Date.now();
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), probeTimeoutMs);
    try {
      const response = await fetch(healthPath, {
        method: 'GET',
        signal: controller.signal,
        cache: 'no-store',
      });
      if (!response.ok) throw new Error(`health probe returned ${response.status}`);
      const elapsed = Date.now() - startedAt;
      setLatencyMs(elapsed);
      const hadFailure = sawFailureRef.current;
      sawFailureRef.current = false;
      setStatus(elapsed > slowProbeMs || hadFailure ? 'degraded' : 'ready');
    } catch {
      sawFailureRef.current = true;
      // Drop the previous round-trip so a stale latency is never shown next to
      // the offline/degraded state.
      setLatencyMs(null);
      setStatus('offline');
    } finally {
      window.clearTimeout(timeoutId);
      inFlightRef.current = false;
    }
  }, [healthPath, probeTimeoutMs, slowProbeMs]);

  // Bump the nonce and let the effect below run the probe. Probing directly
  // here as well would race the nonce-triggered effect: depending on timing,
  // the effect's unconditional setStatus('connecting') could clobber the
  // direct probe's result (or fire a duplicate probe), making call counts and
  // final status nondeterministic.
  const retry = useCallback(() => {
    sawFailureRef.current = true;
    setProbeNonce(n => n + 1);
  }, []);

  useEffect(() => {
    if (!enabled || typeof window === 'undefined' || typeof fetch !== 'function') {
      return;
    }
    setStatus('connecting');
    void probe();
    const intervalId = window.setInterval(() => {
      void probe();
    }, probeIntervalMs);
    const handleOnline = () => {
      void probe();
    };
    window.addEventListener('online', handleOnline);
    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener('online', handleOnline);
    };
  }, [enabled, healthPath, probeIntervalMs, probeTimeoutMs, slowProbeMs, probeNonce, probe]);

  return { status, latencyMs, retry };
}

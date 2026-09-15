import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useRuntimeConnectivity } from '@/hooks/useRuntimeConnectivity.js';

const okResponse = () => new Response(null, { status: 200 });

const settleProbe = async (ms = 0) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

describe('useRuntimeConnectivity', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(okResponse());
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('reports connecting while the first probe is in flight, then ready on success', async () => {
    const { result } = renderHook(() => useRuntimeConnectivity());

    expect(result.current.status).toBe('connecting');

    await settleProbe();

    expect(result.current.status).toBe('ready');
    expect(fetchMock).toHaveBeenCalledWith('/healthz', expect.objectContaining({ cache: 'no-store' }));
    expect(result.current.latencyMs).toBeDefined();
  });

  it('reports offline when the probe rejects', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));

    const { result } = renderHook(() => useRuntimeConnectivity());

    await settleProbe();

    expect(result.current.status).toBe('offline');
  });

  it('reports offline when the probe answers with a non-ok status', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 503 }));

    const { result } = renderHook(() => useRuntimeConnectivity());

    await settleProbe();

    expect(result.current.status).toBe('offline');
  });

  it('reports degraded when the probe succeeds slowly', async () => {
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>(resolve => {
          setTimeout(() => resolve(okResponse()), 2000);
        }),
    );

    const { result } = renderHook(() => useRuntimeConnectivity({ slowProbeMs: 1500 }));

    await settleProbe(2000);

    expect(result.current.status).toBe('degraded');
    expect(result.current.latencyMs).toBeGreaterThan(1500);
  });

  it('reports degraded when a probe succeeds after an earlier failure, then recovers to ready', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'));

    const { result } = renderHook(() => useRuntimeConnectivity({ probeIntervalMs: 60_000 }));

    await settleProbe();
    expect(result.current.status).toBe('offline');

    await settleProbe(60_000);
    expect(result.current.status).toBe('degraded');

    await settleProbe(60_000);
    expect(result.current.status).toBe('ready');
  });

  it('re-probes on demand through retry()', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'));

    const { result } = renderHook(() => useRuntimeConnectivity());

    await settleProbe();
    expect(result.current.status).toBe('offline');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.retry();
    });
    await settleProbe();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.status).toBe('degraded');
  });

  it('re-probes exactly once per retry() and clears stale latency on failure', async () => {
    const { result } = renderHook(() => useRuntimeConnectivity());

    await settleProbe();
    expect(result.current.status).toBe('ready');
    expect(result.current.latencyMs).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockRejectedValueOnce(new Error('network down'));
    act(() => {
      result.current.retry();
    });
    await settleProbe();

    // One retry triggers exactly one probe: the nonce-triggered effect is the
    // single probe path, so call counts stay deterministic.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.status).toBe('offline');
    // The failed probe must not leave the previous round-trip visible.
    expect(result.current.latencyMs).toBeNull();
  });

  it('re-probes when the browser comes back online', async () => {
    const { result } = renderHook(() => useRuntimeConnectivity());

    await settleProbe();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    await settleProbe();

    expect(result.current.status).toBe('ready');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('stays connecting without probing when fetch is unavailable', async () => {
    vi.stubGlobal('fetch', undefined);

    const { result } = renderHook(() => useRuntimeConnectivity());

    await settleProbe();
    expect(result.current.status).toBe('connecting');

    act(() => {
      result.current.retry();
    });
    await settleProbe();
    expect(result.current.status).toBe('connecting');
  });
});

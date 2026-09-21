// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  server: null as unknown,
  refresh: vi.fn(),
}));

vi.mock('@/server/ServerContext.js', () => ({
  useOptionalServer: () => mocks.server,
  useOptionalRefreshServerCapabilities: () => mocks.refresh,
}));

import { useMemorySummarizeSetting } from '@/containers/SettingsBuilder/memorySummarizeSetting.js';

type SummarizeState = {
  enabled: boolean;
  overridden: boolean;
  defaultEnabled: boolean;
  effectiveEnabled: boolean;
};

const STORED_ON: SummarizeState = { enabled: true, overridden: true, defaultEnabled: false, effectiveEnabled: true };

function memorySummarizeServer(overrides: {
  getMemorySummarize?: () => Promise<SummarizeState>;
  setMemorySummarizeEnabled?: (enabled: boolean | null) => Promise<SummarizeState>;
}) {
  return {
    memorySummarize: {
      getMemorySummarize: overrides.getMemorySummarize ?? (async () => STORED_ON),
      setMemorySummarizeEnabled: overrides.setMemorySummarizeEnabled ?? (async () => STORED_ON),
    },
  };
}

beforeEach(() => {
  mocks.server = null;
  mocks.refresh.mockReset();
});

describe('useMemorySummarizeSetting', () => {
  it('reports unsupported when the server has no memorySummarize port', () => {
    mocks.server = {};
    const { result } = renderHook(() => useMemorySummarizeSetting());
    expect(result.current.supported).toBe(false);
  });

  it('loads the stored setting from the port', async () => {
    mocks.server = memorySummarizeServer({});
    const { result } = renderHook(() => useMemorySummarizeSetting());

    await waitFor(() => {
      expect(result.current.enabled).toBe(true);
    });
    expect(result.current).toMatchObject({ supported: true, overridden: true, defaultEnabled: false });
  });

  it('flips optimistically on setEnabled and converges on the server response', async () => {
    let resolvePut: (value: SummarizeState) => void = () => {};
    const putGate = new Promise<SummarizeState>(resolve => {
      resolvePut = resolve;
    });
    const writes: Array<boolean | null> = [];
    mocks.server = memorySummarizeServer({
      setMemorySummarizeEnabled: async enabled => {
        writes.push(enabled);
        return putGate;
      },
    });
    const { result } = renderHook(() => useMemorySummarizeSetting());
    await waitFor(() => {
      expect(result.current.enabled).toBe(true);
    });

    let write: Promise<void> | undefined;
    act(() => {
      write = result.current.setEnabled(false);
    });
    // Optimistic: the switch shows off before the server answers.
    expect(result.current.enabled).toBe(false);
    expect(result.current.saving).toBe(true);

    await act(async () => {
      resolvePut({ enabled: false, overridden: true, defaultEnabled: false, effectiveEnabled: false });
      await write;
    });
    expect(writes).toEqual([false]);
    expect(result.current).toMatchObject({ enabled: false, overridden: true, error: null, saving: false });
  });

  it('rolls back and surfaces the error when a write fails', async () => {
    mocks.server = memorySummarizeServer({
      setMemorySummarizeEnabled: async () => {
        throw new Error('boom');
      },
    });
    const { result } = renderHook(() => useMemorySummarizeSetting());
    await waitFor(() => {
      expect(result.current.enabled).toBe(true);
    });

    await act(async () => {
      await expect(result.current.setEnabled(false)).rejects.toThrow('boom');
    });
    expect(result.current.enabled).toBe(true);
    expect(result.current.error).toBe('boom');
    expect(result.current.saving).toBe(false);
  });

  it('clearOverride writes null and optimistically returns to the server default', async () => {
    const writes: Array<boolean | null> = [];
    mocks.server = memorySummarizeServer({
      setMemorySummarizeEnabled: async enabled => {
        writes.push(enabled);
        return { enabled: false, overridden: false, defaultEnabled: false, effectiveEnabled: false };
      },
    });
    const { result } = renderHook(() => useMemorySummarizeSetting());
    await waitFor(() => {
      expect(result.current.enabled).toBe(true);
    });

    let write: Promise<void> | undefined;
    act(() => {
      write = result.current.clearOverride();
    });
    expect(result.current.enabled).toBe(false);

    await act(async () => {
      await write;
    });
    expect(writes).toEqual([null]);
    expect(result.current).toMatchObject({ enabled: false, overridden: false });
  });

  it('exposes the effective state the toggle shows, including the blocked case', async () => {
    mocks.server = memorySummarizeServer({
      getMemorySummarize: async () => ({
        enabled: true,
        overridden: true,
        defaultEnabled: true,
        effectiveEnabled: false,
      }),
    });
    const { result } = renderHook(() => useMemorySummarizeSetting());

    await waitFor(() => {
      expect(result.current.enabled).toBe(true);
    });
    // Stored says on, but the server will not summarize: the toggle shows the truth.
    expect(result.current.effectiveEnabled).toBe(false);
  });

  it('starts from the server default when nothing is stored', async () => {
    mocks.server = memorySummarizeServer({
      getMemorySummarize: async () => ({
        enabled: false,
        overridden: false,
        defaultEnabled: false,
        effectiveEnabled: false,
      }),
    });
    const { result } = renderHook(() => useMemorySummarizeSetting());

    await waitFor(() => {
      expect(result.current.enabled).toBe(false);
    });
    expect(result.current.overridden).toBe(false);
  });
});

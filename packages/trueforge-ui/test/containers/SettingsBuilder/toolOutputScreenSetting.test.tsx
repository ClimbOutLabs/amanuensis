// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  server: null as unknown,
  capabilities: null as unknown,
  refresh: vi.fn(),
}));

vi.mock('@/server/ServerContext.js', () => ({
  useOptionalServer: () => mocks.server,
  useServerCapabilities: () => mocks.capabilities,
  useOptionalRefreshServerCapabilities: () => mocks.refresh,
}));

import { useToolOutputScreenSetting } from '@/containers/SettingsBuilder/toolOutputScreenSetting.js';

const STORED_ON = { enabled: true, overridden: true, defaultEnabled: false };

function toolOutputScreenServer(overrides: {
  getToolOutputScreen?: () => Promise<{ enabled: boolean; overridden: boolean; defaultEnabled: boolean }>;
  setToolOutputScreenEnabled?: (
    enabled: boolean | null,
  ) => Promise<{ enabled: boolean; overridden: boolean; defaultEnabled: boolean }>;
}) {
  return {
    toolOutputScreen: {
      getToolOutputScreen: overrides.getToolOutputScreen ?? (async () => STORED_ON),
      setToolOutputScreenEnabled: overrides.setToolOutputScreenEnabled ?? (async () => STORED_ON),
    },
  };
}

beforeEach(() => {
  mocks.server = null;
  mocks.capabilities = null;
  mocks.refresh.mockReset();
});

describe('useToolOutputScreenSetting', () => {
  it('reports unsupported when the server has no toolOutputScreen port', () => {
    mocks.server = {};
    const { result } = renderHook(() => useToolOutputScreenSetting());
    expect(result.current.supported).toBe(false);
  });

  it('loads the stored setting independently of capabilities (memory may be disconnected)', async () => {
    mocks.server = toolOutputScreenServer({});
    mocks.capabilities = null;
    const { result } = renderHook(() => useToolOutputScreenSetting());

    await waitFor(() => {
      expect(result.current.enabled).toBe(true);
    });
    expect(result.current).toMatchObject({ supported: true, overridden: true, defaultEnabled: false });
  });

  it('flips optimistically on setEnabled and converges on the server response', async () => {
    let resolvePut: (value: { enabled: boolean; overridden: boolean; defaultEnabled: boolean }) => void = () => {};
    const putGate = new Promise<{ enabled: boolean; overridden: boolean; defaultEnabled: boolean }>(resolve => {
      resolvePut = resolve;
    });
    const writes: Array<boolean | null> = [];
    mocks.server = toolOutputScreenServer({
      setToolOutputScreenEnabled: async enabled => {
        writes.push(enabled);
        return putGate;
      },
    });
    const { result } = renderHook(() => useToolOutputScreenSetting());
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
      resolvePut({ enabled: false, overridden: true, defaultEnabled: false });
      await write;
    });
    expect(writes).toEqual([false]);
    expect(result.current).toMatchObject({ enabled: false, overridden: true, error: null, saving: false });
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it('rolls back and surfaces the error when a write fails', async () => {
    mocks.server = toolOutputScreenServer({
      setToolOutputScreenEnabled: async () => {
        throw new Error('boom');
      },
    });
    const { result } = renderHook(() => useToolOutputScreenSetting());
    await waitFor(() => {
      expect(result.current.enabled).toBe(true);
    });

    await act(async () => {
      await expect(result.current.setEnabled(false)).rejects.toThrow('boom');
    });
    expect(result.current.enabled).toBe(true);
    expect(result.current.error).toBe('boom');
    expect(result.current.saving).toBe(false);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it('clearOverride writes null and optimistically returns to the server default', async () => {
    const writes: Array<boolean | null> = [];
    mocks.server = toolOutputScreenServer({
      setToolOutputScreenEnabled: async enabled => {
        writes.push(enabled);
        return { enabled: false, overridden: false, defaultEnabled: false };
      },
    });
    const { result } = renderHook(() => useToolOutputScreenSetting());
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

  it('renders the effective state when unconfigured, even with a stored ON override', async () => {
    // Env default ON with a stale ON override, but no screening service configured: the
    // capabilities report the effective state (off) and the stored value must not leak
    // into the switch. `overridden` still reports the stale override so the reset
    // link can offer to clear it.
    const STORED_ON_DEFAULT_ON = { enabled: true, overridden: true, defaultEnabled: true };
    mocks.server = toolOutputScreenServer({
      getToolOutputScreen: async () => STORED_ON_DEFAULT_ON,
      setToolOutputScreenEnabled: async () => STORED_ON_DEFAULT_ON,
    });
    mocks.capabilities = {
      toolOutputScreen: { enabled: false, configured: false, reason: 'No screening service configured' },
    };
    const { result } = renderHook(() => useToolOutputScreenSetting());

    await waitFor(() => {
      expect(result.current.overridden).toBe(true);
    });
    expect(result.current.enabled).toBe(false);
  });

  it('prefers the stored value over the capability flag when the service is configured', async () => {
    mocks.server = toolOutputScreenServer({});
    mocks.capabilities = { toolOutputScreen: { enabled: false, configured: true } };
    const { result } = renderHook(() => useToolOutputScreenSetting());

    await waitFor(() => {
      expect(result.current.enabled).toBe(true);
    });
  });
});

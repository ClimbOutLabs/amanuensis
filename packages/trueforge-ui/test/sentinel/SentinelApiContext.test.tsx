// @vitest-environment jsdom
import { act, render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  SentinelApiProvider,
  useOptionalSentinelApiState,
  type SentinelApiState,
} from '@/sentinel/SentinelApiContext.js';
import type { SentinelApi, SentinelUserSettings } from '@/sentinel/types.js';

const INITIAL: SentinelUserSettings = {
  offline_mode: false,
  tier2_auto_allow: [],
  search_without_asking: true,
  maps_without_asking: false,
  sandbox_without_asking: true,
};

function Capture({ into }: { into: { current: SentinelApiState | null } }) {
  into.current = useOptionalSentinelApiState();
  return null;
}

/** A server stand-in: `save` decides how each PATCH behaves, then the patch merges into `stored`. */
function mountProvider(save: (patch: Partial<SentinelUserSettings>, call: number) => Promise<void>) {
  const state: { stored: SentinelUserSettings; saves: number } = { stored: INITIAL, saves: 0 };
  const api: SentinelApi = {
    listAuditEntries: vi.fn(async () => []),
    listUserAuditEntries: vi.fn(async () => ({ entries: [] })),
    getUserSettings: vi.fn(async () => state.stored),
    updateUserSettings: vi.fn(async (patch: Partial<SentinelUserSettings>) => {
      state.saves += 1;
      await save(patch, state.saves);
      state.stored = { ...state.stored, ...patch };
      return state.stored;
    }),
    listSentinelSessionContext: vi.fn(async () => ({ approvals: [] })),
  };
  const captured: { current: SentinelApiState | null } = { current: null };
  render(
    <SentinelApiProvider api={api}>
      <Capture into={captured} />
    </SentinelApiProvider>,
  );
  const sentinel = (): SentinelApiState => {
    if (captured.current === null) throw new Error('provider not mounted');
    return captured.current;
  };
  return { api, sentinel, state };
}

describe('SentinelApiProvider.updateSettings', () => {
  it('runs edits one at a time, each deriving from the settings the previous one saved', async () => {
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });
    const { sentinel, state } = mountProvider(async (_patch, call) => {
      if (call === 1) await firstGate;
    });
    await waitFor(() => {
      expect(sentinel().settings).toEqual(INITIAL);
    });

    const flip = (current: SentinelUserSettings) => ({ offline_mode: !current.offline_mode });
    let results: Promise<SentinelUserSettings>[] = [];
    act(() => {
      results = [sentinel().updateSettings(flip), sentinel().updateSettings(flip)];
    });
    releaseFirst();
    await act(async () => {
      await Promise.all(results);
    });

    // Computed from a stale snapshot, both flips would send true and the setting would stay on.
    expect(state.stored.offline_mode).toBe(false);
    await waitFor(() => {
      expect(sentinel().settings?.offline_mode).toBe(false);
    });
  });

  it('a failed save rejects, leaves the latest settings alone, and does not block later saves', async () => {
    const { api, sentinel, state } = mountProvider(async (_patch, call) => {
      if (call === 1) throw new Error('Save failed.');
    });
    await waitFor(() => {
      expect(sentinel().settings).toEqual(INITIAL);
    });

    let failing: Promise<SentinelUserSettings> = Promise.resolve(INITIAL);
    let following: Promise<SentinelUserSettings> = Promise.resolve(INITIAL);
    act(() => {
      failing = sentinel().updateSettings({ offline_mode: true });
      // Queued while the failing save is still in flight.
      following = sentinel().updateSettings(current => ({
        tier2_auto_allow: [...current.tier2_auto_allow, 'file_write'],
      }));
    });
    await expect(failing).rejects.toThrow('Save failed.');
    await act(async () => {
      await following;
    });

    // The failed edit never reached the stored settings, and the next edit built on the last good ones.
    expect(state.stored).toEqual({
      offline_mode: false,
      tier2_auto_allow: ['file_write'],
      search_without_asking: true,
      maps_without_asking: false,
      sandbox_without_asking: true,
    });
    await waitFor(() => {
      expect(sentinel().settings).toEqual({
        offline_mode: false,
        tier2_auto_allow: ['file_write'],
        search_without_asking: true,
        maps_without_asking: false,
        sandbox_without_asking: true,
      });
    });
    expect(api.updateUserSettings).toHaveBeenCalledTimes(2);

    // Later saves keep working and keep building on the latest result.
    await act(async () => {
      await sentinel().updateSettings(current => ({ offline_mode: !current.offline_mode }));
    });
    expect(state.stored).toEqual({
      offline_mode: true,
      tier2_auto_allow: ['file_write'],
      search_without_asking: true,
      maps_without_asking: false,
      sandbox_without_asking: true,
    });
  });
});

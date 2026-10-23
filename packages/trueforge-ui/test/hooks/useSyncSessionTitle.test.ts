// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const useThreadIsRunning = vi.fn(() => false);
const useAuiState = vi.fn();
const rename = vi.fn(async () => undefined);
const getSession = vi.fn();
const useOptionalServer = vi.fn((): { getSession: typeof getSession } | null => null);
let rowTitle: string | undefined;

vi.mock('@assistant-ui/core/react', () => ({
  useThreadIsRunning: () => useThreadIsRunning(),
}));

vi.mock('@/assistant-ui.js', () => ({
  useAui: () => ({
    threadListItem: () => ({ rename }),
  }),
  useAuiState: (selector: (state: unknown) => unknown) => useAuiState(selector),
}));

vi.mock('@/server/ServerContext.js', () => ({
  useOptionalServer: () => useOptionalServer(),
}));

import { useSyncSessionTitle } from '@/hooks/useSyncSessionTitle.js';

/** Lets pending promise callbacks and timers run, as the browser would between frames. */
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Simulates a turn that starts and then finishes. */
function finishTurn(rerender: () => void) {
  useThreadIsRunning.mockReturnValue(true);
  rerender();
  useThreadIsRunning.mockReturnValue(false);
  rerender();
}

describe('useSyncSessionTitle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useThreadIsRunning.mockReturnValue(false);
    useOptionalServer.mockReturnValue({ getSession });
    rename.mockClear();
    getSession.mockReset();
    rowTitle = 'Hello chat, how are you?';
    useAuiState.mockImplementation((selector: (state: unknown) => unknown) =>
      selector({
        threadListItem: { remoteId: 'sess-1', title: rowTitle },
      }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renames the thread list row to the server title after a turn finishes', async () => {
    getSession.mockResolvedValue({ id: 'sess-1', title: 'Greeting and check-in' });

    const { rerender } = renderHook(() => useSyncSessionTitle());
    finishTurn(() => rerender());
    await advance(0);

    expect(getSession).toHaveBeenCalledWith({ sessionId: 'sess-1' });
    expect(rename).toHaveBeenCalledWith('Greeting and check-in');
  });

  it('picks up a title the server writes after the first read, with one delayed read', async () => {
    getSession
      .mockResolvedValueOnce({ id: 'sess-1', title: '' })
      .mockResolvedValueOnce({ id: 'sess-1', title: 'Late generated title' });

    const { rerender } = renderHook(() => useSyncSessionTitle());
    finishTurn(() => rerender());
    await advance(0);

    expect(getSession).toHaveBeenCalledTimes(1);
    expect(rename).not.toHaveBeenCalled();

    await advance(5_000);

    expect(getSession).toHaveBeenCalledTimes(2);
    expect(rename).toHaveBeenCalledWith('Late generated title');
  });

  it('does not rename or re-read when the server title matches the row', async () => {
    rowTitle = 'Same title';
    getSession.mockResolvedValue({ id: 'sess-1', title: 'Same title' });

    const { rerender } = renderHook(() => useSyncSessionTitle());
    finishTurn(() => rerender());
    await advance(0);
    await advance(5_000);

    expect(rename).not.toHaveBeenCalled();
    expect(getSession).toHaveBeenCalledTimes(2);
  });

  it('does not poll again after the single delayed read', async () => {
    getSession.mockResolvedValue({ id: 'sess-1', title: '' });

    const { rerender } = renderHook(() => useSyncSessionTitle());
    finishTurn(() => rerender());
    await advance(0);
    await advance(5_000);
    await advance(60_000);

    expect(getSession).toHaveBeenCalledTimes(2);
    expect(rename).not.toHaveBeenCalled();
  });

  it('does not fetch while the turn is still running', async () => {
    useThreadIsRunning.mockReturnValue(true);
    renderHook(() => useSyncSessionTitle());

    await advance(0);

    expect(getSession).not.toHaveBeenCalled();
  });

  it('cancels the delayed read on unmount', async () => {
    getSession.mockResolvedValue({ id: 'sess-1', title: '' });

    const { rerender, unmount } = renderHook(() => useSyncSessionTitle());
    finishTurn(() => rerender());
    await advance(0);
    expect(vi.getTimerCount()).toBe(1);

    unmount();
    expect(vi.getTimerCount()).toBe(0);

    await advance(10_000);
    expect(getSession).toHaveBeenCalledTimes(1);
    expect(rename).not.toHaveBeenCalled();
  });
});

// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CHAT_LIST_REFRESH_INTERVAL_MS, useChatListRefresh } from '@/hooks/useChatListRefresh.js';

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  document.dispatchEvent(new Event('visibilitychange'));
}

afterEach(() => {
  setHidden(false);
  vi.useRealTimers();
});

describe('useChatListRefresh', () => {
  it('refreshes about once a minute while the list is visible', async () => {
    vi.useFakeTimers();
    const onRefresh = vi.fn();
    renderHook(() => useChatListRefresh({ onRefresh }));

    await vi.advanceTimersByTimeAsync(CHAT_LIST_REFRESH_INTERVAL_MS - 1);
    expect(onRefresh).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(onRefresh).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(CHAT_LIST_REFRESH_INTERVAL_MS);
    expect(onRefresh).toHaveBeenCalledTimes(2);
  });

  it('does not refresh on the interval while the page is hidden', async () => {
    vi.useFakeTimers();
    const onRefresh = vi.fn();
    renderHook(() => useChatListRefresh({ onRefresh }));

    act(() => setHidden(true));
    await vi.advanceTimersByTimeAsync(CHAT_LIST_REFRESH_INTERVAL_MS * 3);
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('folds a focus and a visibility return into one refresh', async () => {
    vi.useFakeTimers();
    const onRefresh = vi.fn();
    renderHook(() => useChatListRefresh({ onRefresh }));

    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('focus'));
    });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});

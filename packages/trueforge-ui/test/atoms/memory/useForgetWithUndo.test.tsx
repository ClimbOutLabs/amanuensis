// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FORGET_UNDO_MS, useForgetWithUndo } from '@/atoms/memory/useForgetWithUndo.js';

describe('useForgetWithUndo', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('holds the forget for ten seconds before the server call', () => {
    const commit = vi.fn(async () => {});
    const { result } = renderHook(() => useForgetWithUndo({ commit }));

    act(() => result.current.forget(['fact-1']));
    expect(result.current.heldIds.has('fact-1')).toBe(true);

    act(() => vi.advanceTimersByTime(FORGET_UNDO_MS - 1));
    expect(commit).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(1));
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith(['fact-1']);
    expect(result.current.heldCount).toBe(0);
  });

  it('waits ten seconds from the forget, not from any earlier call', () => {
    const commit = vi.fn(async () => {});
    const { result } = renderHook(() => useForgetWithUndo({ commit }));

    act(() => result.current.forget(['fact-1', 'fact-2']));
    act(() => vi.advanceTimersByTime(9_000));
    expect(commit).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1_000));
    expect(commit).toHaveBeenCalledWith(['fact-1', 'fact-2']);
  });

  it('cancels the server call when undo runs inside the window', () => {
    const commit = vi.fn(async () => {});
    const { result } = renderHook(() => useForgetWithUndo({ commit }));

    act(() => result.current.forget(['fact-1']));
    act(() => vi.advanceTimersByTime(4_000));
    act(() => result.current.undo());

    expect(result.current.heldIds.has('fact-1')).toBe(false);
    act(() => vi.advanceTimersByTime(FORGET_UNDO_MS * 2));
    expect(commit).not.toHaveBeenCalled();
  });

  it('sends a held batch at once when a new forget starts, so only one undo is offered', () => {
    const commit = vi.fn(async () => {});
    const { result } = renderHook(() => useForgetWithUndo({ commit }));

    act(() => result.current.forget(['fact-1']));
    act(() => vi.advanceTimersByTime(2_000));
    act(() => result.current.forget(['fact-2']));

    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenLastCalledWith(['fact-1']);
    expect(result.current.heldIds.has('fact-2')).toBe(true);
    expect(result.current.heldIds.has('fact-1')).toBe(false);

    act(() => vi.advanceTimersByTime(FORGET_UNDO_MS));
    expect(commit).toHaveBeenCalledTimes(2);
    expect(commit).toHaveBeenLastCalledWith(['fact-2']);
  });

  it('sends the held batch when the page unmounts, so leaving never undoes a forget', () => {
    const commit = vi.fn(async () => {});
    const { result, unmount } = renderHook(() => useForgetWithUndo({ commit }));

    act(() => result.current.forget(['fact-1']));
    unmount();

    expect(commit).toHaveBeenCalledWith(['fact-1']);
    act(() => vi.advanceTimersByTime(FORGET_UNDO_MS));
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('ignores an empty forget', () => {
    const commit = vi.fn(async () => {});
    const { result } = renderHook(() => useForgetWithUndo({ commit }));

    act(() => result.current.forget([]));
    act(() => vi.advanceTimersByTime(FORGET_UNDO_MS));
    expect(commit).not.toHaveBeenCalled();
  });
});

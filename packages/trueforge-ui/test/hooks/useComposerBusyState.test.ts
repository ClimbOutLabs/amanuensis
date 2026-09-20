// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const useThreadIsRunning = vi.fn(() => false);
type FakeMessage = { role: string };
let auiState: { thread: { messages: FakeMessage[] }; threadListItem: { id: string } } = {
  thread: { messages: [] },
  threadListItem: { id: 'thread-1' },
};

vi.mock('@assistant-ui/core/react', () => ({
  useThreadIsRunning: () => useThreadIsRunning(),
}));

vi.mock('@assistant-ui/react', () => ({
  useAuiState: (selector: (state: typeof auiState) => unknown) => selector(auiState),
}));

import {
  ComposerBusyProvider,
  ComposerBusyScopeProvider,
  getActiveComposerSendId,
  notifyComposerBusyFailure,
  useComposerBusyScope,
  useComposerBusyState,
} from '@/hooks/useComposerBusyState.js';

function wrapper({ children }: { children: ReactNode }) {
  return createElement(ComposerBusyProvider, null, children);
}

/** One chat instance's own scope plus its busy state, as `TrueFoundryChatProvider` wires them:
 *  a `ComposerBusyScopeProvider` around a `ComposerBusyProvider`. */
function useScopedInstance() {
  const scope = useComposerBusyScope();
  const busy = useComposerBusyState();
  return { scope, ...busy };
}

function scopedWrapper({ children }: { children: ReactNode }) {
  return createElement(ComposerBusyScopeProvider, null, createElement(ComposerBusyProvider, null, children));
}

describe('useComposerBusyState', () => {
  beforeEach(() => {
    useThreadIsRunning.mockReturnValue(false);
    auiState = { thread: { messages: [] }, threadListItem: { id: 'thread-1' } };
  });

  it('reflects a running thread without marking it as submitting', () => {
    useThreadIsRunning.mockReturnValue(true);
    const { result } = renderHook(() => useComposerBusyState(), { wrapper });

    expect(result.current.isBusy).toBe(true);
    expect(result.current.isRunning).toBe(true);
    expect(result.current.isSubmitting).toBe(false);
  });

  it('starts busy immediately on send before the thread is running', () => {
    const { result } = renderHook(() => useComposerBusyState(), { wrapper });

    act(() => {
      result.current.send(() => undefined);
    });

    expect(result.current.isBusy).toBe(true);
    expect(result.current.isSubmitting).toBe(true);
    expect(result.current.isRunning).toBe(false);
  });

  it('clears submitting when the thread stops running', async () => {
    useThreadIsRunning.mockReturnValue(true);
    const { result, rerender } = renderHook(() => useComposerBusyState(), { wrapper });

    act(() => {
      result.current.send(() => undefined);
    });

    useThreadIsRunning.mockReturnValue(false);
    rerender();

    await waitFor(() => {
      expect(result.current.isBusy).toBe(false);
    });
  });

  it('clears submitting when a reply lands without the running flag ever flipping', async () => {
    const { result, rerender } = renderHook(() => useComposerBusyState(), { wrapper });

    act(() => {
      result.current.send(() => undefined);
    });
    expect(result.current.isSubmitting).toBe(true);

    // The reply lands, but isRunning is never set true for this thread.
    auiState = { thread: { messages: [{ role: 'user' }, { role: 'assistant' }] }, threadListItem: { id: 'thread-1' } };
    rerender();

    await waitFor(() => {
      expect(result.current.isSubmitting).toBe(false);
    });
  });

  it('keeps submitting while the thread only holds the optimistic user echo', () => {
    const { result, rerender } = renderHook(() => useComposerBusyState(), { wrapper });

    act(() => {
      result.current.send(() => undefined);
    });
    expect(result.current.isSubmitting).toBe(true);

    // Only the user's own message has landed so far: not a reply yet.
    auiState = { thread: { messages: [{ role: 'user' }] }, threadListItem: { id: 'thread-1' } };
    rerender();

    expect(result.current.isSubmitting).toBe(true);
  });

  it("does not clear submitting from another thread's reply", async () => {
    const { result, rerender } = renderHook(() => useComposerBusyState(), { wrapper });

    act(() => {
      result.current.send(() => undefined);
    });
    expect(result.current.isSubmitting).toBe(true);

    // The user switches to a different, longer thread before this attempt's own reply lands.
    auiState = {
      thread: { messages: [{ role: 'user' }, { role: 'assistant' }] },
      threadListItem: { id: 'thread-2' },
    };
    rerender();
    expect(result.current.isSubmitting).toBe(true);

    // Switching back to the thread the attempt was actually sent on, with its own reply landed.
    auiState = {
      thread: { messages: [{ role: 'user' }, { role: 'assistant' }] },
      threadListItem: { id: 'thread-1' },
    };
    rerender();

    await waitFor(() => {
      expect(result.current.isSubmitting).toBe(false);
    });
  });

  it('records the thread a send was dispatched on', () => {
    const { result, rerender } = renderHook(() => useComposerBusyState(), { wrapper });

    expect(result.current.sendThreadId).toBeNull();

    act(() => {
      result.current.send(() => undefined);
    });
    expect(result.current.sendThreadId).toBe('thread-1');

    // The user switches to a different thread after the send: the id recorded is still the
    // thread the send was actually dispatched on, not wherever the view has moved to.
    auiState = { thread: { messages: [] }, threadListItem: { id: 'thread-2' } };
    rerender();
    expect(result.current.sendThreadId).toBe('thread-1');
  });

  it('clears submitting when send rejects', async () => {
    const { result } = renderHook(() => useComposerBusyState(), { wrapper });

    act(() => {
      result.current.send(() => Promise.reject(new Error('send failed')));
    });

    expect(result.current.isBusy).toBe(true);

    await waitFor(() => {
      expect(result.current.isBusy).toBe(false);
    });
  });

  it('clears submitting when send throws synchronously', () => {
    const { result } = renderHook(() => useComposerBusyState(), { wrapper });

    act(() => {
      result.current.send(() => {
        throw new Error('send failed');
      });
    });

    expect(result.current.isBusy).toBe(false);
    expect(result.current.isSubmitting).toBe(false);
  });

  it('resetBusy clears optimistic submitting state', () => {
    const { result } = renderHook(() => useComposerBusyState(), { wrapper });

    act(() => {
      result.current.send(() => undefined);
    });
    expect(result.current.isBusy).toBe(true);

    act(() => {
      result.current.resetBusy();
    });
    expect(result.current.isBusy).toBe(false);
  });

  it('clears submitting on notifyComposerBusyFailure when send never starts a run', () => {
    const { result } = renderHook(() => useComposerBusyState(), { wrapper });

    act(() => {
      // Matches aui.composer().send(): void return, rejection swallowed upstream.
      result.current.send(() => undefined);
    });
    expect(result.current.isBusy).toBe(true);
    expect(result.current.isSubmitting).toBe(true);

    act(() => {
      notifyComposerBusyFailure();
    });

    expect(result.current.isBusy).toBe(false);
    expect(result.current.isSubmitting).toBe(false);
  });

  it('ignores a stale failure tagged with an id an earlier, already-superseded send returned', () => {
    const { result } = renderHook(() => useComposerBusyState(), { wrapper });

    let firstId = -1;
    act(() => {
      firstId = result.current.send(() => undefined);
    });
    expect(result.current.isSubmitting).toBe(true);

    // The first attempt's failure signal arrives and is genuinely handled.
    act(() => {
      notifyComposerBusyFailure(firstId);
    });
    expect(result.current.isSubmitting).toBe(false);

    // The user resends; this second attempt is genuinely in flight.
    act(() => {
      result.current.send(() => undefined);
    });
    expect(result.current.isSubmitting).toBe(true);

    // A duplicate/delayed repeat of the FIRST attempt's failure arrives late, after the resend.
    // Tagged with the old id, it must not clear the second attempt's busy state.
    act(() => {
      notifyComposerBusyFailure(firstId);
    });
    expect(result.current.isSubmitting).toBe(true);
  });

  it('still clears unconditionally when no id is given, matching the runtime onError call site', () => {
    const { result } = renderHook(() => useComposerBusyState(), { wrapper });

    act(() => {
      result.current.send(() => undefined);
    });
    act(() => {
      result.current.send(() => undefined);
    });
    expect(result.current.isSubmitting).toBe(true);

    act(() => {
      notifyComposerBusyFailure();
    });
    expect(result.current.isSubmitting).toBe(false);
  });

  it('requires ComposerBusyProvider', () => {
    expect(() => renderHook(() => useComposerBusyState())).toThrow(
      'useComposerBusyState must be used within ComposerBusyProvider',
    );
  });

  it('keeps two chat instances apart even when their own attempt ids collide', () => {
    // Two chats rendered side by side (each its own ComposerBusyScopeProvider, the way
    // TrueFoundryChatProvider wires it): both attempt-id sequences start at 1 independently, so
    // the ids themselves collide. Only the scope tells them apart.
    const a = renderHook(() => useScopedInstance(), { wrapper: scopedWrapper });
    const b = renderHook(() => useScopedInstance(), { wrapper: scopedWrapper });

    let idA = -1;
    act(() => {
      idA = a.result.current.send(() => undefined);
    });
    let idB = -1;
    act(() => {
      idB = b.result.current.send(() => undefined);
    });
    expect(idA).toBe(1);
    expect(idB).toBe(1);
    expect(a.result.current.isSubmitting).toBe(true);
    expect(b.result.current.isSubmitting).toBe(true);

    // Chat A's runtime reports a pre-stream error with no attempt id of its own, so it is stamped
    // with the latest id in A's own scope (exactly what TrueFoundryChatProvider's onError does).
    act(() => {
      notifyComposerBusyFailure(getActiveComposerSendId(a.result.current.scope), a.result.current.scope);
    });

    expect(a.result.current.isSubmitting).toBe(false);
    // Chat B is a different scope with a numerically-colliding id: it must be untouched.
    expect(b.result.current.isSubmitting).toBe(true);
  });

  it('does not broadcast a failure across scopes even with no id given', () => {
    const a = renderHook(() => useScopedInstance(), { wrapper: scopedWrapper });
    const b = renderHook(() => useScopedInstance(), { wrapper: scopedWrapper });

    act(() => {
      a.result.current.send(() => undefined);
      b.result.current.send(() => undefined);
    });
    expect(a.result.current.isSubmitting).toBe(true);
    expect(b.result.current.isSubmitting).toBe(true);

    act(() => {
      notifyComposerBusyFailure(undefined, a.result.current.scope);
    });

    expect(a.result.current.isSubmitting).toBe(false);
    expect(b.result.current.isSubmitting).toBe(true);
  });
});

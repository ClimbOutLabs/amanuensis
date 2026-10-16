'use client';

import { act, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AVATAR_ACTIVITY_ERROR_AUTO_CLEAR_MS,
  AvatarActivityBridge,
  AvatarActivityProvider,
  useAvatarActivitySink,
  type AmanAvatarActivity,
} from '@/hooks/useAvatarActivity.js';
import { ComposerBusyProvider } from '@/hooks/useComposerBusyState.js';

import { RuntimeHarness } from '../containers/RuntimeHarness.js';

function Probe({ onSink }: { onSink: (sink: ReturnType<typeof useAvatarActivitySink>) => void }) {
  const sink = useAvatarActivitySink();
  onSink(sink);
  return null;
}

function renderProvider(onActivity: (activity: AmanAvatarActivity) => void) {
  // A holder object (not a closure-captured `let`): TypeScript narrows a
  // closure-assigned local to `never` after a null check, but a property
  // read narrows normally.
  const holder: { sink: ReturnType<typeof useAvatarActivitySink> } = { sink: null };
  render(
    <AvatarActivityProvider onActivity={onActivity}>
      <Probe
        onSink={next => {
          holder.sink = next;
        }}
      />
    </AvatarActivityProvider>,
  );
  const sink = holder.sink;
  if (sink === null) {
    throw new Error('sink was not provided');
  }
  return sink;
}

describe('AvatarActivityProvider', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits the raw derived activity as it changes, without duplicates', () => {
    const onActivity = vi.fn();
    const sink = renderProvider(onActivity);

    // Subscribing delivers the current activity, even when it is idle.
    expect(onActivity).toHaveBeenCalledTimes(1);
    expect(onActivity).toHaveBeenLastCalledWith('idle');

    act(() => {
      sink.reportDerived({ isBusy: false, isTextStreaming: false });
    });
    expect(onActivity).toHaveBeenCalledTimes(1);

    act(() => {
      sink.reportDerived({ isBusy: true, isTextStreaming: false });
    });
    expect(onActivity).toHaveBeenLastCalledWith('thinking');

    act(() => {
      sink.reportDerived({ isBusy: true, isTextStreaming: false });
    });
    expect(onActivity).toHaveBeenCalledTimes(2);

    act(() => {
      sink.reportDerived({ isBusy: true, isTextStreaming: true });
    });
    expect(onActivity).toHaveBeenLastCalledWith('writing');

    act(() => {
      sink.reportDerived({ isBusy: false, isTextStreaming: false });
    });
    expect(onActivity).toHaveBeenLastCalledWith('idle');
  });

  it('holds the error pose on a surfaced failure and auto-clears to idle', () => {
    const onActivity = vi.fn();
    const sink = renderProvider(onActivity);

    act(() => {
      sink.reportError();
    });
    expect(onActivity).toHaveBeenLastCalledWith('error');

    // Derived idle reports while the error is armed do not clear it early.
    act(() => {
      sink.reportDerived({ isBusy: false, isTextStreaming: false });
    });
    expect(onActivity).toHaveBeenLastCalledWith('error');

    act(() => {
      vi.advanceTimersByTime(AVATAR_ACTIVITY_ERROR_AUTO_CLEAR_MS);
    });
    expect(onActivity).toHaveBeenLastCalledWith('idle');
  });

  it('lets a retry in flight supersede the error pose immediately', () => {
    const onActivity = vi.fn();
    const sink = renderProvider(onActivity);

    act(() => {
      sink.reportError();
    });
    expect(onActivity).toHaveBeenLastCalledWith('error');

    act(() => {
      sink.reportDerived({ isBusy: true, isTextStreaming: false });
    });
    expect(onActivity).toHaveBeenLastCalledWith('thinking');

    // The auto-clear timer was disarmed: nothing further fires.
    act(() => {
      vi.advanceTimersByTime(AVATAR_ACTIVITY_ERROR_AUTO_CLEAR_MS * 2);
    });
    expect(onActivity).toHaveBeenLastCalledWith('thinking');
    expect(onActivity).toHaveBeenCalledTimes(3);
  });

  it('re-arms cleanly when a second error lands while one is armed', () => {
    const onActivity = vi.fn();
    const sink = renderProvider(onActivity);

    act(() => {
      sink.reportError();
    });
    act(() => {
      vi.advanceTimersByTime(AVATAR_ACTIVITY_ERROR_AUTO_CLEAR_MS - 1000);
    });
    act(() => {
      sink.reportError();
    });
    // Only one auto-clear fires, 4s after the latest error.
    act(() => {
      vi.advanceTimersByTime(AVATAR_ACTIVITY_ERROR_AUTO_CLEAR_MS - 1000);
    });
    expect(onActivity).toHaveBeenLastCalledWith('error');
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(onActivity).toHaveBeenLastCalledWith('idle');
  });

  it('hands a late subscriber the current non-idle activity immediately', () => {
    const first = vi.fn();
    const holder: { sink: ReturnType<typeof useAvatarActivitySink> } = { sink: null };
    const { rerender } = render(
      <AvatarActivityProvider onActivity={first}>
        <Probe
          onSink={next => {
            holder.sink = next;
          }}
        />
      </AvatarActivityProvider>,
    );
    const sink = holder.sink;
    if (sink === null) {
      throw new Error('sink was not provided');
    }
    act(() => {
      sink.reportDerived({ isBusy: true, isTextStreaming: false });
    });
    expect(first).toHaveBeenLastCalledWith('thinking');

    // The host re-subscribes with a new callback identity: it gets the current activity
    // at once instead of waiting for the next transition.
    const second = vi.fn();
    rerender(
      <AvatarActivityProvider onActivity={second}>
        <Probe
          onSink={next => {
            holder.sink = next;
          }}
        />
      </AvatarActivityProvider>,
    );
    expect(second).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledWith('thinking');
  });

  it('delivers the current idle activity to a late subscriber instead of staying silent', () => {
    const first = vi.fn();
    const { rerender } = render(
      <AvatarActivityProvider onActivity={first}>
        <div />
      </AvatarActivityProvider>,
    );
    // Even idle is delivered on subscribe: a parent holding a stale activity from a
    // previous provider instance clears instead of sticking.
    expect(first).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledWith('idle');

    const second = vi.fn();
    rerender(
      <AvatarActivityProvider onActivity={second}>
        <div />
      </AvatarActivityProvider>,
    );
    expect(second).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledWith('idle');
  });
});

describe('AvatarActivityBridge', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function renderBridge(node: ReactNode, onActivity: (activity: AmanAvatarActivity) => void) {
    render(<AvatarActivityProvider onActivity={onActivity}>{node}</AvatarActivityProvider>);
  }

  it('delivers the current idle activity on subscribe while the thread is idle', () => {
    const onActivity = vi.fn();
    renderBridge(
      <RuntimeHarness messages={[]}>
        <ComposerBusyProvider>
          <AvatarActivityBridge />
        </ComposerBusyProvider>
      </RuntimeHarness>,
      onActivity,
    );
    expect(onActivity).toHaveBeenCalledTimes(1);
    expect(onActivity).toHaveBeenLastCalledWith('idle');
  });

  it('reports thinking while the thread runs without visible streaming', () => {
    const onActivity = vi.fn();
    renderBridge(
      <RuntimeHarness messages={[]} isRunning>
        <ComposerBusyProvider>
          <AvatarActivityBridge />
        </ComposerBusyProvider>
      </RuntimeHarness>,
      onActivity,
    );
    expect(onActivity).toHaveBeenLastCalledWith('thinking');
  });

  it('reports writing while the latest assistant text part streams', () => {
    const onActivity = vi.fn();
    renderBridge(
      <RuntimeHarness
        messages={[
          { role: 'user', content: 'hello' },
          // A running thread with a fresh assistant message reads as still streaming.
          { role: 'assistant', content: 'hi' },
        ]}
        isRunning
      >
        <ComposerBusyProvider>
          <AvatarActivityBridge />
        </ComposerBusyProvider>
      </RuntimeHarness>,
      onActivity,
    );
    expect(onActivity).toHaveBeenLastCalledWith('writing');
  });

  it('reports thinking while the thread runs on tool calls rather than text', () => {
    const onActivity = vi.fn();
    renderBridge(
      <RuntimeHarness
        messages={[
          { role: 'user', content: 'hello' },
          {
            role: 'assistant',
            content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'read_file', args: {} }],
          },
        ]}
        isRunning
      >
        <ComposerBusyProvider>
          <AvatarActivityBridge />
        </ComposerBusyProvider>
      </RuntimeHarness>,
      onActivity,
    );
    expect(onActivity).toHaveBeenLastCalledWith('thinking');
  });

  it('reports thinking while the turn is parked waiting on the user (tool approval)', () => {
    const onActivity = vi.fn();
    renderBridge(
      <RuntimeHarness
        messages={[
          { role: 'user', content: 'delete the file' },
          {
            role: 'assistant',
            // The runtime is NOT running: the turn is parked on the user's approval
            // decision. Without the blocked-on-user signal the avatar would idle here
            // while the turn is still open.
            status: { type: 'requires-action', reason: 'tool-calls' },
            content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'delete_file', args: {} }],
          },
        ]}
      >
        <ComposerBusyProvider>
          <AvatarActivityBridge />
        </ComposerBusyProvider>
      </RuntimeHarness>,
      onActivity,
    );
    expect(onActivity).toHaveBeenLastCalledWith('thinking');
  });

  it('reports thinking while the turn is parked on an ask-user answer', () => {
    const onActivity = vi.fn();
    renderBridge(
      <RuntimeHarness
        messages={[
          { role: 'user', content: 'book it' },
          {
            role: 'assistant',
            status: { type: 'requires-action', reason: 'tool-calls' },
            content: [{ type: 'tool-call', toolCallId: 'call-2', toolName: 'ask_user', args: {} }],
          },
        ]}
      >
        <ComposerBusyProvider>
          <AvatarActivityBridge />
        </ComposerBusyProvider>
      </RuntimeHarness>,
      onActivity,
    );
    expect(onActivity).toHaveBeenLastCalledWith('thinking');
  });

  it('reports idle for a turn whose parked approval already resolved', () => {
    const onActivity = vi.fn();
    // A fresh mount over already-resolved messages: the bridge reads the current
    // thread state on subscribe, so the avatar never sticks on thinking for a turn
    // that is no longer parked. (Swapping the messages prop on a live
    // useExternalStoreRuntime does not notify useAuiState subscribers in this
    // assistant-ui version, so the resolution is exercised as a remount — the same
    // shape as navigating back to a settled conversation.)
    renderBridge(
      <RuntimeHarness
        messages={[
          { role: 'user', content: 'delete the file' },
          {
            role: 'assistant',
            status: { type: 'complete', reason: 'stop' },
            content: 'Understood, I will not delete the file.',
          },
        ]}
      >
        <ComposerBusyProvider>
          <AvatarActivityBridge />
        </ComposerBusyProvider>
      </RuntimeHarness>,
      onActivity,
    );
    expect(onActivity).toHaveBeenLastCalledWith('idle');
  });
});

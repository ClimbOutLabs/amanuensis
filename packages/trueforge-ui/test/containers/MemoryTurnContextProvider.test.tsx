// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const useThreadIsRunning = vi.fn(() => false);
const useAuiState = vi.fn();

vi.mock('@assistant-ui/core/react', () => ({
  useThreadIsRunning: () => useThreadIsRunning(),
}));

vi.mock('@/assistant-ui.js', () => ({
  useAuiState: (selector: (state: unknown) => unknown) => useAuiState(selector),
}));

import type { MemoryTurnContext } from '@/components/MemoryRecallContext.js';
import { MemoryRecallProvider, type MemoryRecallApi } from '@/components/MemoryRecallContext.js';
import {
  MemoryTurnContextProvider,
  useMemoryTurnContext,
  useMemoryTurnContextStatus,
} from '@/containers/MemoryTurnContextProvider.js';

const renders = new Map<string, number>();

function Probe({ turnId }: { turnId: string }) {
  renders.set(turnId, (renders.get(turnId) ?? 0) + 1);
  const context = useMemoryTurnContext(turnId);
  const { hasError, retry } = useMemoryTurnContextStatus();
  return (
    <div>
      <span data-testid={`profile-revision-${turnId}`}>{context?.profile?.revision ?? 'none'}</span>
      <span data-testid={`has-error-${turnId}`}>{String(hasError)}</span>
      <button type="button" onClick={retry}>
        retry {turnId}
      </button>
    </div>
  );
}

function tree(api: MemoryRecallApi, turnIds: string[] = ['trn_1']) {
  return (
    <MemoryRecallProvider api={api}>
      <MemoryTurnContextProvider>
        {turnIds.map(turnId => (
          <Probe key={turnId} turnId={turnId} />
        ))}
      </MemoryTurnContextProvider>
    </MemoryRecallProvider>
  );
}

function profileContext(turnId: string, revision = 1): MemoryTurnContext {
  return {
    turnId,
    profile: {
      type: 'aman.profile.learned',
      id: `evt_profile_${turnId}_${String(revision)}`,
      createdAt: '2026-08-03T00:00:01.000Z',
      previous: null,
      current: '# Learned profile',
      revision,
    },
  };
}

function recallContext(turnId: string): MemoryTurnContext {
  return {
    turnId,
    recall: {
      type: 'aman.memory.recall',
      id: `evt_recall_${turnId}`,
      createdAt: '2026-08-03T00:00:00.000Z',
      injectedBlock: '<aman-memory>fact</aman-memory>',
      stats: {
        items: 1,
        entities: 0,
        droppedOverBudget: 0,
        droppedBelowThreshold: 0,
        estimatedTokens: 4,
        recallMs: 3,
        budgetReason: 'normal',
        outcome: 'ok',
      },
      sweep: { verified: 0, retried: 0, abandoned: 0, pending: 0 },
    },
  };
}

let threadMessages: { role: string; metadata: { custom: Record<string, unknown> } }[] = [];
let visibility: DocumentVisibilityState = 'visible';

function setVisibility(next: DocumentVisibilityState) {
  visibility = next;
  document.dispatchEvent(new Event('visibilitychange'));
}

async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('MemoryTurnContextProvider', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    renders.clear();
    threadMessages = [];
    visibility = 'visible';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
    useThreadIsRunning.mockReturnValue(false);
    useAuiState.mockImplementation((selector: (state: unknown) => unknown) =>
      selector({ threadListItem: { remoteId: 'sess-1' }, thread: { messages: threadMessages } }),
    );
  });

  afterEach(() => {
    Reflect.deleteProperty(document, 'visibilityState');
    vi.useRealTimers();
  });

  it('does not discard a slow response when a poll tick fires before it resolves', async () => {
    useThreadIsRunning.mockReturnValue(true);
    let resolveFirst: (items: MemoryTurnContext[]) => void = () => {};
    const firstCall = new Promise<MemoryTurnContext[]>(resolve => {
      resolveFirst = resolve;
    });
    const listMemoryTurnContext = vi
      .fn()
      .mockReturnValueOnce(firstCall)
      .mockResolvedValue([profileContext('trn_1')]);

    render(tree({ listMemoryTurnContext }));

    // Two more 2s ticks fire while the first request is still in flight.
    await flush(4_000);
    // Only the original request went out — the in-flight one was not abandoned for a new one.
    expect(listMemoryTurnContext).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirst([profileContext('trn_1')]);
      await Promise.resolve();
      await Promise.resolve();
    });

    // The slow response was applied rather than thrown away.
    expect(screen.getByTestId('profile-revision-trn_1')).toHaveTextContent('1');
  });

  it('loads the whole session once, then asks only for events newer than the newest one held', async () => {
    useThreadIsRunning.mockReturnValue(true);
    const listMemoryTurnContext = vi
      .fn()
      .mockResolvedValueOnce([recallContext('trn_1')])
      .mockResolvedValue([]);

    render(tree({ listMemoryTurnContext }));
    await flush();
    await flush(2_000);

    expect(listMemoryTurnContext).toHaveBeenNthCalledWith(1, 'sess-1', undefined);
    expect(listMemoryTurnContext).toHaveBeenNthCalledWith(2, 'sess-1', { afterEventId: 'evt_recall_trn_1' });
  });

  it('makes zero renders on polls that find nothing new, and re-renders only the turn that changed', async () => {
    useThreadIsRunning.mockReturnValue(true);
    const turnIds = ['trn_1', 'trn_2', 'trn_3'];
    // Every poll returns fresh objects with the same content, as a full re-read would.
    let response = (): MemoryTurnContext[] => turnIds.map(recallContext);
    const listMemoryTurnContext = vi.fn(async () => response());

    render(tree({ listMemoryTurnContext }, turnIds));
    await flush();
    const settled = new Map(renders);

    await flush(20_000);
    expect(listMemoryTurnContext.mock.calls.length).toBeGreaterThanOrEqual(10);
    expect(renders).toEqual(settled);

    response = () => [...turnIds.map(recallContext), profileContext('trn_2')];
    await flush(2_000);
    expect(screen.getByTestId('profile-revision-trn_2')).toHaveTextContent('1');
    expect(renders.get('trn_2')).toBe((settled.get('trn_2') ?? 0) + 1);
    expect(renders.get('trn_1')).toBe(settled.get('trn_1'));
    expect(renders.get('trn_3')).toBe(settled.get('trn_3'));
  });

  it('stops polling while the page is hidden and catches up when it is shown again', async () => {
    useThreadIsRunning.mockReturnValue(true);
    const listMemoryTurnContext = vi.fn().mockResolvedValue([]);
    render(tree({ listMemoryTurnContext }));
    await flush(2_000);
    const beforeHide = listMemoryTurnContext.mock.calls.length;

    await act(async () => {
      setVisibility('hidden');
    });
    await flush(20_000);
    expect(listMemoryTurnContext).toHaveBeenCalledTimes(beforeHide);

    listMemoryTurnContext.mockResolvedValue([profileContext('trn_1')]);
    await act(async () => {
      setVisibility('visible');
    });
    await flush();
    expect(listMemoryTurnContext).toHaveBeenCalledTimes(beforeHide + 1);
    expect(screen.getByTestId('profile-revision-trn_1')).toHaveTextContent('1');

    await flush(2_000);
    expect(listMemoryTurnContext).toHaveBeenCalledTimes(beforeHide + 2);
  });

  it('keeps polling for a grace period after the thread stops, so a late profile-learned write is not missed', async () => {
    useThreadIsRunning.mockReturnValue(true);
    const listMemoryTurnContext = vi.fn().mockResolvedValue([]);
    const { rerender } = render(tree({ listMemoryTurnContext }));
    await flush();
    expect(screen.getByTestId('profile-revision-trn_1')).toHaveTextContent('none');

    // Turn completes: isRunning flips false, but profile learning is still writing its event.
    useThreadIsRunning.mockReturnValue(false);
    listMemoryTurnContext.mockResolvedValue([profileContext('trn_1')]);
    rerender(tree({ listMemoryTurnContext }));

    // A poll well after the stop (but inside the grace window) still picks it up.
    await flush(20_000);
    expect(screen.getByTestId('profile-revision-trn_1')).toHaveTextContent('1');
  });

  it("stops polling once the finished turn's profile event arrives", async () => {
    threadMessages = [
      { role: 'user', metadata: { custom: {} } },
      { role: 'assistant', metadata: { custom: { turnId: 'trn_1' } } },
    ];
    useThreadIsRunning.mockReturnValue(true);
    const listMemoryTurnContext = vi.fn().mockResolvedValue([]);
    const { rerender } = render(tree({ listMemoryTurnContext }));
    await flush();

    useThreadIsRunning.mockReturnValue(false);
    rerender(tree({ listMemoryTurnContext }));
    await flush(4_000);
    listMemoryTurnContext.mockResolvedValue([profileContext('trn_1')]);
    await flush(2_000);
    expect(screen.getByTestId('profile-revision-trn_1')).toHaveTextContent('1');
    const afterProfile = listMemoryTurnContext.mock.calls.length;

    await flush(60_000);
    expect(listMemoryTurnContext).toHaveBeenCalledTimes(afterProfile);
  });

  it('stops polling when the grace period ends without a profile event', async () => {
    useThreadIsRunning.mockReturnValue(true);
    const listMemoryTurnContext = vi.fn().mockResolvedValue([]);
    const { rerender } = render(tree({ listMemoryTurnContext }));
    await flush();

    useThreadIsRunning.mockReturnValue(false);
    rerender(tree({ listMemoryTurnContext }));
    await flush(66_000);
    const afterGrace = listMemoryTurnContext.mock.calls.length;

    await flush(60_000);
    expect(listMemoryTurnContext).toHaveBeenCalledTimes(afterGrace);
  });

  it('surfaces a fetch failure instead of silently rendering as if nothing happened, and clears it on retry', async () => {
    const listMemoryTurnContext = vi.fn().mockRejectedValueOnce(new Error('network down')).mockResolvedValue([]);
    render(tree({ listMemoryTurnContext }));

    await flush();
    expect(screen.getByTestId('has-error-trn_1')).toHaveTextContent('true');

    await act(async () => {
      screen.getByRole('button', { name: 'retry trn_1' }).click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId('has-error-trn_1')).toHaveTextContent('false');
  });
});

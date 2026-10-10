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

function profileContext(turnId: string, { id = `evt_profile_${turnId}_1` }: { id?: string } = {}): MemoryTurnContext {
  return {
    turnId,
    profile: {
      type: 'aman.profile.learned',
      id,
      createdAt: '2026-08-03T00:00:01.000Z',
      previous: null,
      current: '# Learned profile',
      revision: 1,
    },
  };
}

function recallContext(turnId: string, { id = `evt_recall_${turnId}` }: { id?: string } = {}): MemoryTurnContext {
  return {
    turnId,
    recall: {
      type: 'aman.memory.recall',
      id,
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
let remoteId = 'sess-1';
let visibility: DocumentVisibilityState = 'visible';

/** Assistant messages stamped with these turn ids, so the last one is the newest turn. */
function assistantTurns(...turnIds: string[]): typeof threadMessages {
  return turnIds.map(turnId => ({ role: 'assistant', metadata: { custom: { turnId } } }));
}

/**
 * Per-session event log that answers like the server: a cursor read returns only events whose id
 * sorts after the cursor, so an event saved with an older id than one already read is invisible
 * to cursor reads and shows up only in a full read. Each item carries one event, like a page row.
 */
function eventLog() {
  const saved = new Map<string, MemoryTurnContext[]>();
  const listMemoryTurnContext = vi.fn(
    async (sessionId: string, options?: { afterEventId?: string | undefined }): Promise<MemoryTurnContext[]> => {
      const after = options?.afterEventId;
      return (saved.get(sessionId) ?? [])
        .filter(item => after === undefined || (item.recall?.id ?? item.profile?.id ?? '') > after)
        .map(item => structuredClone(item));
    },
  );
  const save = (sessionId: string, ...items: MemoryTurnContext[]) => {
    saved.set(sessionId, [...(saved.get(sessionId) ?? []), ...items]);
  };
  return { listMemoryTurnContext, save };
}

type EventLog = ReturnType<typeof eventLog>;

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
    remoteId = 'sess-1';
    visibility = 'visible';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
    useThreadIsRunning.mockReturnValue(false);
    useAuiState.mockImplementation((selector: (state: unknown) => unknown) =>
      selector({ threadListItem: { remoteId }, thread: { messages: threadMessages } }),
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
    let response = (): MemoryTurnContext[] => turnIds.map(turnId => recallContext(turnId));
    const listMemoryTurnContext = vi.fn(async () => response());

    render(tree({ listMemoryTurnContext }, turnIds));
    await flush();
    const settled = new Map(renders);

    await flush(20_000);
    expect(listMemoryTurnContext.mock.calls.length).toBeGreaterThanOrEqual(10);
    expect(renders).toEqual(settled);

    response = () => [...turnIds.map(turnId => recallContext(turnId)), profileContext('trn_2')];
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

  it("stops polling once the finished turn's profile event arrives, leaving only the closing full read", async () => {
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

    await flush(50_000);
    expect(listMemoryTurnContext).toHaveBeenCalledTimes(afterProfile);

    // The grace period still closes with one full read, for profiles saved behind the cursor.
    await flush(10_000);
    expect(listMemoryTurnContext).toHaveBeenCalledTimes(afterProfile + 1);
    expect(listMemoryTurnContext).toHaveBeenLastCalledWith('sess-1', undefined);
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

  describe('events saved behind the cursor', () => {
    const turns = ['trn_1', 'trn_2'];

    /**
     * trn_1 and trn_2 are loaded (cursor evt_03) and the run has just ended. trn_1's profile is
     * yet to be saved as evt_02: its id came before trn_2's recall, so cursor reads cannot see it.
     */
    async function endRunWithBothTurnsLoaded() {
      threadMessages = assistantTurns(...turns);
      const log = eventLog();
      log.save('sess-1', recallContext('trn_1', { id: 'evt_01' }), recallContext('trn_2', { id: 'evt_03' }));
      const api = { listMemoryTurnContext: log.listMemoryTurnContext };
      useThreadIsRunning.mockReturnValue(true);
      const { rerender } = render(tree(api, turns));
      await flush();
      useThreadIsRunning.mockReturnValue(false);
      rerender(tree(api, turns));
      return log;
    }

    /** Lets trn_2's own profile arrive, which ends polling, then saves trn_1's profile behind the cursor. */
    async function saveProfilesAfterPollingEnds(log: EventLog) {
      log.save('sess-1', profileContext('trn_2', { id: 'evt_04' }));
      await flush(2_000);
      expect(screen.getByTestId('profile-revision-trn_2')).toHaveTextContent('1');
      log.save('sess-1', profileContext('trn_1', { id: 'evt_02' }));
    }

    it('re-reads the whole history when the grace period ends, rendering only what changed', async () => {
      const log = await endRunWithBothTurnsLoaded();
      await saveProfilesAfterPollingEnds(log);
      const polled = log.listMemoryTurnContext.mock.calls.length;

      await flush(60_000);
      expect(log.listMemoryTurnContext).toHaveBeenCalledTimes(polled);
      expect(screen.getByTestId('profile-revision-trn_1')).toHaveTextContent('none');

      const settled = new Map(renders);
      await flush(5_000);
      expect(log.listMemoryTurnContext).toHaveBeenCalledTimes(polled + 1);
      expect(log.listMemoryTurnContext).toHaveBeenLastCalledWith('sess-1', undefined);
      expect(screen.getByTestId('profile-revision-trn_1')).toHaveTextContent('1');
      expect(renders.get('trn_1')).toBe((settled.get('trn_1') ?? 0) + 1);
      expect(renders.get('trn_2')).toBe(settled.get('trn_2'));
    });

    it('retries a failed closing read as a full read', async () => {
      const log = await endRunWithBothTurnsLoaded();
      await saveProfilesAfterPollingEnds(log);

      log.listMemoryTurnContext.mockRejectedValueOnce(new Error('network down'));
      await flush(65_000);
      expect(screen.getByTestId('has-error-trn_1')).toHaveTextContent('true');
      expect(screen.getByTestId('profile-revision-trn_1')).toHaveTextContent('none');

      await act(async () => {
        screen.getByRole('button', { name: 'retry trn_1' }).click();
      });
      await flush();
      expect(log.listMemoryTurnContext).toHaveBeenLastCalledWith('sess-1', undefined);
      expect(screen.getByTestId('has-error-trn_1')).toHaveTextContent('false');
      expect(screen.getByTestId('profile-revision-trn_1')).toHaveTextContent('1');
    });

    it('skips the closing read while the page is hidden and does it when the page is shown', async () => {
      const log = await endRunWithBothTurnsLoaded();
      await act(async () => {
        setVisibility('hidden');
      });
      const whileHidden = log.listMemoryTurnContext.mock.calls.length;

      // The grace period ends while hidden, and the profile is saved after that.
      await flush(70_000);
      log.save('sess-1', profileContext('trn_1', { id: 'evt_02' }));
      await flush(10_000);
      expect(log.listMemoryTurnContext).toHaveBeenCalledTimes(whileHidden);
      expect(screen.getByTestId('profile-revision-trn_1')).toHaveTextContent('none');

      await act(async () => {
        setVisibility('visible');
      });
      await flush();
      expect(log.listMemoryTurnContext).toHaveBeenCalledTimes(whileHidden + 1);
      expect(log.listMemoryTurnContext).toHaveBeenLastCalledWith('sess-1', undefined);
      expect(screen.getByTestId('profile-revision-trn_1')).toHaveTextContent('1');

      await flush(60_000);
      expect(log.listMemoryTurnContext).toHaveBeenCalledTimes(whileHidden + 1);
    });
  });

  it('picks up a profile that lands after the grace period when the next run polls', async () => {
    const log = eventLog();
    log.save('sess-1', recallContext('trn_1', { id: 'evt_01' }));
    const api = { listMemoryTurnContext: log.listMemoryTurnContext };
    useThreadIsRunning.mockReturnValue(true);
    const { rerender } = render(tree(api));
    await flush();

    useThreadIsRunning.mockReturnValue(false);
    rerender(tree(api));
    await flush(70_000);
    const afterGrace = log.listMemoryTurnContext.mock.calls.length;

    log.save('sess-1', profileContext('trn_1', { id: 'evt_02' }));
    await flush(60_000);
    expect(log.listMemoryTurnContext).toHaveBeenCalledTimes(afterGrace);
    expect(screen.getByTestId('profile-revision-trn_1')).toHaveTextContent('none');

    useThreadIsRunning.mockReturnValue(true);
    rerender(tree(api));
    await flush(2_000);
    expect(log.listMemoryTurnContext).toHaveBeenLastCalledWith('sess-1', { afterEventId: 'evt_01' });
    expect(screen.getByTestId('profile-revision-trn_1')).toHaveTextContent('1');
  });

  it("starts a switched session from its own history instead of the previous session's cursor", async () => {
    const log = eventLog();
    log.save('sess-1', recallContext('trn_1', { id: 'evt_90' }), profileContext('trn_1', { id: 'evt_91' }));
    log.save('sess-2', recallContext('trn_2', { id: 'evt_10' }));
    const api = { listMemoryTurnContext: log.listMemoryTurnContext };
    useThreadIsRunning.mockReturnValue(true);
    const { rerender } = render(tree(api, ['trn_1', 'trn_2']));
    await flush();
    expect(screen.getByTestId('profile-revision-trn_1')).toHaveTextContent('1');

    remoteId = 'sess-2';
    rerender(tree(api, ['trn_1', 'trn_2']));
    await flush();
    expect(log.listMemoryTurnContext).toHaveBeenLastCalledWith('sess-2', undefined);
    expect(screen.getByTestId('profile-revision-trn_1')).toHaveTextContent('none');

    // evt_50 sorts below the previous session's newest event, so a carried-over cursor would hide it.
    log.save('sess-2', profileContext('trn_2', { id: 'evt_50' }));
    await flush(2_000);
    expect(log.listMemoryTurnContext).toHaveBeenLastCalledWith('sess-2', { afterEventId: 'evt_10' });
    expect(screen.getByTestId('profile-revision-trn_2')).toHaveTextContent('1');
  });

  it('keeps a full read queued behind a slow poll from being downgraded by a later poll tick', async () => {
    useThreadIsRunning.mockReturnValue(true);
    let release: (items: MemoryTurnContext[]) => void = () => {};
    const slowPoll = new Promise<MemoryTurnContext[]>(resolve => {
      release = resolve;
    });
    const listMemoryTurnContext = vi
      .fn()
      .mockResolvedValueOnce([recallContext('trn_1')])
      .mockReturnValueOnce(slowPoll)
      .mockResolvedValue([]);
    render(tree({ listMemoryTurnContext }));
    await flush();
    await flush(2_000);
    expect(listMemoryTurnContext).toHaveBeenCalledTimes(2);

    // Showing the page queues a full read behind the poll that is still out; the next tick joins it.
    await act(async () => {
      setVisibility('hidden');
    });
    await act(async () => {
      setVisibility('visible');
    });
    await flush(2_000);
    expect(listMemoryTurnContext).toHaveBeenCalledTimes(2);

    await act(async () => {
      release([]);
    });
    await flush();
    expect(listMemoryTurnContext).toHaveBeenCalledTimes(3);
    expect(listMemoryTurnContext).toHaveBeenLastCalledWith('sess-1', undefined);
  });

  it("does not re-read a switched session when the previous session's grace period ends", async () => {
    const log = eventLog();
    log.save('sess-1', recallContext('trn_1', { id: 'evt_01' }));
    log.save('sess-2', recallContext('trn_2', { id: 'evt_02' }));
    const api = { listMemoryTurnContext: log.listMemoryTurnContext };
    useThreadIsRunning.mockReturnValue(true);
    const { rerender } = render(tree(api));
    await flush();

    useThreadIsRunning.mockReturnValue(false);
    rerender(tree(api));
    await flush(30_000);

    remoteId = 'sess-2';
    rerender(tree(api));
    await flush();
    const loaded = log.listMemoryTurnContext.mock.calls.length;

    // The first session's grace period would have ended somewhere in here.
    await flush(60_000);
    expect(log.listMemoryTurnContext).toHaveBeenCalledTimes(loaded);
  });
});

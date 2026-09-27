// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

function Probe({ turnId }: { turnId: string }) {
  const context = useMemoryTurnContext(turnId);
  const { hasError, retry } = useMemoryTurnContextStatus();
  return (
    <div>
      <span data-testid="profile-revision">{context?.profile?.revision ?? 'none'}</span>
      <span data-testid="has-error">{String(hasError)}</span>
      <button type="button" onClick={retry}>
        retry
      </button>
    </div>
  );
}

function renderProvider(api: MemoryRecallApi) {
  return render(
    <MemoryRecallProvider api={api}>
      <MemoryTurnContextProvider>
        <Probe turnId="trn_1" />
      </MemoryTurnContextProvider>
    </MemoryRecallProvider>,
  );
}

const profileContext: MemoryTurnContext = {
  turnId: 'trn_1',
  profile: {
    type: 'aman.profile.learned',
    id: 'evt_profile_1',
    createdAt: '2026-08-03T00:00:01.000Z',
    previous: null,
    current: '# Learned profile',
    revision: 1,
  },
};

describe('MemoryTurnContextProvider', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useThreadIsRunning.mockReturnValue(false);
    useAuiState.mockImplementation((selector: (state: unknown) => unknown) =>
      selector({ threadListItem: { remoteId: 'sess-1' } }),
    );
  });

  it('does not discard a slow response when a poll tick fires before it resolves', async () => {
    useThreadIsRunning.mockReturnValue(true);
    let resolveFirst!: (items: MemoryTurnContext[]) => void;
    const firstCall = new Promise<MemoryTurnContext[]>(resolve => {
      resolveFirst = resolve;
    });
    const listMemoryTurnContext = vi.fn().mockReturnValueOnce(firstCall).mockResolvedValue([profileContext]);

    renderProvider({ listMemoryTurnContext });

    // Two more 2s ticks fire while the first request is still in flight.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    // Only the original request went out — the in-flight one was not abandoned for a new one.
    expect(listMemoryTurnContext).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirst([profileContext]);
      await Promise.resolve();
      await Promise.resolve();
    });

    // The slow response was applied rather than thrown away.
    expect(screen.getByTestId('profile-revision')).toHaveTextContent('1');
  });

  it('keeps polling for a grace period after the thread stops, so a late profile-learned write is not missed', async () => {
    useThreadIsRunning.mockReturnValue(true);
    const listMemoryTurnContext = vi.fn().mockResolvedValue([]);
    const { rerender } = render(
      <MemoryRecallProvider api={{ listMemoryTurnContext }}>
        <MemoryTurnContextProvider>
          <Probe turnId="trn_1" />
        </MemoryTurnContextProvider>
      </MemoryRecallProvider>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId('profile-revision')).toHaveTextContent('none');

    // Turn completes: isRunning flips false, but profile learning is still writing its event.
    useThreadIsRunning.mockReturnValue(false);
    listMemoryTurnContext.mockResolvedValue([profileContext]);
    rerender(
      <MemoryRecallProvider api={{ listMemoryTurnContext }}>
        <MemoryTurnContextProvider>
          <Probe turnId="trn_1" />
        </MemoryTurnContextProvider>
      </MemoryRecallProvider>,
    );

    // A poll well after the stop (but inside the grace window) still picks it up.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(screen.getByTestId('profile-revision')).toHaveTextContent('1');
  });

  it('surfaces a fetch failure instead of silently rendering as if nothing happened, and clears it on retry', async () => {
    const listMemoryTurnContext = vi.fn().mockRejectedValueOnce(new Error('network down')).mockResolvedValue([]);
    renderProvider({ listMemoryTurnContext });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId('has-error')).toHaveTextContent('true');

    await act(async () => {
      screen.getByRole('button', { name: 'retry' }).click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId('has-error')).toHaveTextContent('false');
  });
});

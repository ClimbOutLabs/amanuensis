// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  HarnessChatServerExtensions,
  LastCompactionStatus,
} from '@/plugins/trueforge-agent-server-adapter/sessionResync.js';

const useThreadIsRunning = vi.fn(() => false);
let auiState: { threadListItem?: { remoteId?: string } } = {
  threadListItem: { remoteId: 'session-1' },
};
const useTrueFoundryAgentSpec = vi.fn(() => ({ agentSpec: null }));
const useOptionalServer = vi.fn((): HarnessChatServerExtensions | null => null);

vi.mock('@assistant-ui/core/react', () => ({
  useThreadIsRunning: () => useThreadIsRunning(),
}));

vi.mock('@assistant-ui/react', () => ({
  useAuiState: (selector: (state: typeof auiState) => unknown) => selector(auiState),
}));

vi.mock('@truefoundry/assistant-ui-runtime', () => ({
  useTrueFoundryAgentSpec: () => useTrueFoundryAgentSpec(),
}));

vi.mock('@/server/ServerContext.js', () => ({
  useOptionalServer: () => useOptionalServer(),
}));

import { useCompactionStatus } from '@/hooks/useCompactionStatus.js';

describe('useCompactionStatus', () => {
  const getLastCompactionStatus = vi.fn(async (): Promise<LastCompactionStatus | null> => null);
  const getLastTurnInputTokens = vi.fn(async (): Promise<number | null> => null);
  // hasSessionResync checks for these methods via Reflect; a plain object with
  // all four methods passes.
  const server: HarnessChatServerExtensions = {
    peekSessionTip: vi.fn(async () => null),
    dismissPendingApprovals: vi.fn(async () => ({ dismissed: 0, alreadyResolved: true })),
    getLastCompactionStatus,
    getLastTurnInputTokens,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    useThreadIsRunning.mockReturnValue(false);
    auiState = { threadListItem: { remoteId: 'session-1' } };
    useTrueFoundryAgentSpec.mockReturnValue({ agentSpec: null });
    useOptionalServer.mockReturnValue(server);
  });

  it('fetches the compaction status for the active session', async () => {
    getLastCompactionStatus.mockResolvedValueOnce({
      createdAt: '2026-09-27T11:30:00Z',
      outcome: 'applied',
    });
    getLastTurnInputTokens.mockResolvedValueOnce(77200);

    const { result } = renderHook(() => useCompactionStatus());

    await waitFor(() => expect(getLastCompactionStatus).toHaveBeenCalledTimes(1));
    expect(getLastCompactionStatus).toHaveBeenCalledWith({ sessionId: 'session-1' });
    await waitFor(() => expect(result.current.lastCompaction?.outcome).toBe('applied'));
    expect(result.current.liveTokens).toBe(77200);
  });

  it('refreshes the status after a turn ends', async () => {
    const { result, rerender } = renderHook(() => useCompactionStatus());

    await waitFor(() => expect(getLastCompactionStatus).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.loading).toBe(false));

    // A turn starts and ends; the hook must re-fetch instead of staying stale.
    useThreadIsRunning.mockReturnValue(true);
    rerender();
    useThreadIsRunning.mockReturnValue(false);
    rerender();

    await waitFor(() => expect(getLastCompactionStatus).toHaveBeenCalledTimes(2));
    expect(getLastCompactionStatus).toHaveBeenLastCalledWith({ sessionId: 'session-1' });
  });

  it('does not refetch while a turn is still running', async () => {
    const { rerender } = renderHook(() => useCompactionStatus());

    await waitFor(() => expect(getLastCompactionStatus).toHaveBeenCalledTimes(1));

    useThreadIsRunning.mockReturnValue(true);
    rerender();
    // Still running: no new fetch.
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 10));
    });
    expect(getLastCompactionStatus).toHaveBeenCalledTimes(1);
  });
});

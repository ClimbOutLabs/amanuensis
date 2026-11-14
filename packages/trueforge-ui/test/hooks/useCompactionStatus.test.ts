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
type SpecStub = { agentSpec: { model: { name: string } } | null };
const useTrueFoundryAgentSpec = vi.fn((): SpecStub => ({ agentSpec: null }));
type ModelStub = { name: string; properties: { contextLength?: number; maxOutputTokens?: number } };
let catalogModels: ModelStub[] = [];
const ensureLoaded = vi.fn();
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

vi.mock('@/atoms/draft/DraftCatalogProvider.js', () => ({
  useDraftCatalog: () => ({ models: catalogModels, ensureLoaded }),
}));

vi.mock('@/server/ServerContext.js', () => ({
  useOptionalServer: () => useOptionalServer(),
}));

import { useCompactionStatus } from '@/hooks/useCompactionStatus.js';

describe('useCompactionStatus', () => {
  const getLastCompactionStatus = vi.fn(async (): Promise<LastCompactionStatus | null> => null);
  const getLastCallInputTokens = vi.fn(async (): Promise<number | null> => null);
  // hasSessionResync checks for these methods via Reflect; a plain object with
  // all five methods passes.
  const server: HarnessChatServerExtensions = {
    peekSessionTip: vi.fn(async () => null),
    dismissPendingApprovals: vi.fn(async () => ({ dismissed: 0, alreadyResolved: true })),
    dismissEndedApproval: vi.fn(async () => undefined),
    answerHeldAction: vi.fn<HarnessChatServerExtensions['answerHeldAction']>(async () => 'done'),
    getLastCompactionStatus,
    getLastCallInputTokens,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    useThreadIsRunning.mockReturnValue(false);
    auiState = { threadListItem: { remoteId: 'session-1' } };
    useTrueFoundryAgentSpec.mockReturnValue({ agentSpec: null });
    catalogModels = [];
    useOptionalServer.mockReturnValue(server);
  });

  it('reads what the model can hold from the model list, by the name the chat uses', async () => {
    useTrueFoundryAgentSpec.mockReturnValue({ agentSpec: { model: { name: 'demo/small' } } });
    catalogModels = [
      { name: 'demo/large', properties: { contextLength: 1_000_000 } },
      { name: 'demo/small', properties: { contextLength: 131_072, maxOutputTokens: 8_192 } },
    ];
    getLastCallInputTokens.mockResolvedValueOnce(12);

    const { result } = renderHook(() => useCompactionStatus());

    await waitFor(() => expect(result.current.liveTokens).toBe(12));
    expect(ensureLoaded).toHaveBeenCalled();
    expect(result.current.contextLimit).toBe(131_072);
    expect(result.current.maxOutputTokens).toBe(8_192);
  });

  it('leaves the limit unknown when the model list does not say it', async () => {
    useTrueFoundryAgentSpec.mockReturnValue({ agentSpec: { model: { name: 'demo/small' } } });
    catalogModels = [{ name: 'demo/small', properties: {} }];
    getLastCallInputTokens.mockResolvedValueOnce(12);

    const { result } = renderHook(() => useCompactionStatus());

    await waitFor(() => expect(result.current.liveTokens).toBe(12));
    expect(result.current.contextLimit).toBeNull();
  });

  it('does not load the model list for a chat with nothing to show yet', async () => {
    const { result } = renderHook(() => useCompactionStatus());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(ensureLoaded).not.toHaveBeenCalled();
  });

  it('fetches the compaction status for the active session', async () => {
    getLastCompactionStatus.mockResolvedValueOnce({
      createdAt: '2026-09-27T11:30:00Z',
      outcome: 'applied',
    });
    getLastCallInputTokens.mockResolvedValueOnce(77200);

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

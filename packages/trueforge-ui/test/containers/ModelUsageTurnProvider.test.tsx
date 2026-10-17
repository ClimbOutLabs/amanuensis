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

import { ModelUsageProvider, type ModelUsageApi } from '@/components/ModelUsageContext.js';
import { ModelUsageTurnProvider, useModelUsageSummary } from '@/containers/ModelUsageTurnProvider.js';
import { NANO_SUMMARY_EVENT, SUPER_EVENT } from '../fixtures/modelUsageEvents.js';

function Probe({ turnId }: { turnId: string }) {
  const summary = useModelUsageSummary(turnId);
  return (
    <span data-testid="probe">
      {summary === undefined
        ? 'none'
        : `${summary.answer.displayName}:${String(summary.inputTokens + summary.outputTokens)}`}
    </span>
  );
}

function tree(api: ModelUsageApi) {
  return (
    <ModelUsageProvider api={api}>
      <ModelUsageTurnProvider>
        <Probe turnId="trn_1" />
      </ModelUsageTurnProvider>
    </ModelUsageProvider>
  );
}

describe('ModelUsageTurnProvider', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useThreadIsRunning.mockReturnValue(false);
    useAuiState.mockImplementation((selector: (state: unknown) => unknown) =>
      selector({ threadListItem: { remoteId: 'sess-1' } }),
    );
  });

  it("summarizes a turn's usage by turn id", async () => {
    const listModelUsage = vi.fn().mockResolvedValue([{ turnId: 'trn_1', events: [SUPER_EVENT] }]);
    render(tree({ listModelUsage }));

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(listModelUsage).toHaveBeenCalledWith('sess-1');
    expect(screen.getByTestId('probe')).toHaveTextContent('Nemotron 3 Super:2140');
  });

  it("picks up the helper calls recorded after the turn ends, and adds them to the turn's total", async () => {
    useThreadIsRunning.mockReturnValue(true);
    const listModelUsage = vi.fn().mockResolvedValue([{ turnId: 'trn_1', events: [SUPER_EVENT] }]);
    const { rerender } = render(tree({ listModelUsage }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId('probe')).toHaveTextContent('Nemotron 3 Super:2140');

    useThreadIsRunning.mockReturnValue(false);
    listModelUsage.mockResolvedValue([{ turnId: 'trn_1', events: [SUPER_EVENT, NANO_SUMMARY_EVENT] }]);
    rerender(tree({ listModelUsage }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });

    expect(screen.getByTestId('probe')).toHaveTextContent('Nemotron 3 Super:2690');
  });

  it('keeps what loaded when a later refresh fails', async () => {
    useThreadIsRunning.mockReturnValue(true);
    const listModelUsage = vi
      .fn()
      .mockResolvedValueOnce([{ turnId: 'trn_1', events: [SUPER_EVENT] }])
      .mockRejectedValue(new Error('offline'));
    render(tree({ listModelUsage }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(screen.getByTestId('probe')).toHaveTextContent('Nemotron 3 Super:2140');
  });

  it('renders children and shows nothing when no host provider is mounted', () => {
    render(
      <ModelUsageTurnProvider>
        <Probe turnId="trn_1" />
      </ModelUsageTurnProvider>,
    );

    expect(screen.getByTestId('probe')).toHaveTextContent('none');
  });
});

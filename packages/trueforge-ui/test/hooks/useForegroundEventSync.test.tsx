// @vitest-environment jsdom
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@assistant-ui/react', async importOriginal => {
  const actual = await importOriginal<typeof import('@assistant-ui/react')>();
  return {
    ...actual,
    useAuiState: (selector: (state: unknown) => unknown) =>
      selector({ threadListItem: { remoteId: 'ses_1' } }),
  };
});

const reload = vi.fn();
vi.mock('@truefoundry/assistant-ui-runtime', () => ({
  useTrueFoundryReload: () => reload,
}));

const showSuccess = vi.fn();
const showError = vi.fn();
vi.mock('@/containers/ToasterContainer.js', () => ({
  useToasterOptional: () => ({ showSuccess, showError }),
}));

import { ServerProvider } from '@/server/ServerContext.js';
import { ForegroundEventSync } from '@/hooks/useForegroundEventSync.js';
import { publishBlockedSend } from '@/plugins/trueforge-agent-server-adapter/sessionResync.js';
import type { SessionTipInfo } from '@/plugins/trueforge-agent-server-adapter/sessionResync.js';

let hidden = false;
Object.defineProperty(document, 'hidden', {
  configurable: true,
  get: () => hidden,
});

function tipWith(overrides: Partial<SessionTipInfo> = {}): SessionTipInfo {
  return { turnId: 'trn_1', status: 'done', pendingApprovals: [], ...overrides };
}

function oldApproval(minutes: number) {
  return {
    toolCallId: 'call_1',
    threadId: 'main',
    createdAt: new Date(Date.now() - minutes * 60_000).toISOString(),
  };
}

describe('ForegroundEventSync lifecycle journeys', () => {
  let peekSessionTip: ReturnType<typeof vi.fn>;
  let dismissPendingApprovals: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-25T12:00:00.000Z'));
    hidden = false;
    peekSessionTip = vi.fn(async () => tipWith());
    dismissPendingApprovals = vi.fn(async () => ({ dismissed: 0, alreadyResolved: true }));
    reload.mockClear();
    showSuccess.mockClear();
    showError.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function renderSync() {
    render(
      <ServerProvider
        server={
          {
            getCapabilities: vi.fn(async () => ({ data: {} })),
            peekSessionTip,
            dismissPendingApprovals,
          } as never
        }
      >
        <ForegroundEventSync />
      </ServerProvider>,
    );
  }

  async function backgroundThenForeground(hiddenMs: number) {
    hidden = true;
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await vi.advanceTimersByTimeAsync(hiddenMs);
    hidden = false;
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await vi.advanceTimersByTimeAsync(5_000);
  }

  it('probes the tip once after a long hide, and does not reload when nothing moved', async () => {
    renderSync();
    await backgroundThenForeground(60_000);

    expect(peekSessionTip).toHaveBeenCalledTimes(1);
    expect(peekSessionTip).toHaveBeenCalledWith({ sessionId: 'ses_1' });
    expect(reload).not.toHaveBeenCalled();
  });

  it('skips the probe after a short hide (routine tab switch)', async () => {
    renderSync();
    await backgroundThenForeground(5_000);

    expect(peekSessionTip).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it('coalesces visibilitychange and focus into a single probe', async () => {
    renderSync();
    hidden = true;
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await vi.advanceTimersByTimeAsync(60_000);
    hidden = false;
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('focus'));
    });
    await vi.advanceTimersByTimeAsync(5_000);

    expect(peekSessionTip).toHaveBeenCalledTimes(1);
  });

  it('reloads when the tip moved while the page was away', async () => {
    peekSessionTip
      .mockResolvedValueOnce(tipWith({ turnId: 'trn_1' }))
      .mockResolvedValueOnce(tipWith({ turnId: 'trn_2' }));
    renderSync();
    await backgroundThenForeground(60_000);
    await backgroundThenForeground(60_000);

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('reloads to surface pending approvals found by a blocked send', async () => {
    peekSessionTip.mockResolvedValue(tipWith({ pendingApprovals: [oldApproval(5)] }));
    renderSync();

    await act(async () => {
      publishBlockedSend();
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(peekSessionTip).toHaveBeenCalledTimes(1);
    expect(dismissPendingApprovals).not.toHaveBeenCalled();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('auto-denies approvals older than 30 minutes using the persisted timestamp', async () => {
    peekSessionTip.mockResolvedValue(tipWith({ pendingApprovals: [oldApproval(45)] }));
    dismissPendingApprovals.mockResolvedValue({ dismissed: 1, alreadyResolved: false });
    renderSync();
    await backgroundThenForeground(60_000);

    expect(dismissPendingApprovals).toHaveBeenCalledTimes(1);
    const [request] = dismissPendingApprovals.mock.calls[0] as [{ sessionId: string; reason: string }];
    expect(request.sessionId).toBe('ses_1');
    expect(request.reason).toMatch(/30 minutes/);
    expect(showSuccess).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does not auto-deny recent approvals, it only surfaces them', async () => {
    peekSessionTip.mockResolvedValue(tipWith({ pendingApprovals: [oldApproval(5)] }));
    renderSync();
    await backgroundThenForeground(60_000);

    expect(dismissPendingApprovals).not.toHaveBeenCalled();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('reports a failed probe once instead of crashing the sync', async () => {
    peekSessionTip.mockRejectedValue(new Error('server unreachable'));
    renderSync();
    await backgroundThenForeground(60_000);

    // 3 attempts, then one error toast.
    expect(peekSessionTip).toHaveBeenCalledTimes(3);
    expect(showError).toHaveBeenCalledTimes(1);
  });
});

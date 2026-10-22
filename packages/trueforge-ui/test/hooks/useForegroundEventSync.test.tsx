// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const threadRunning = vi.hoisted(() => ({ current: false }));

vi.mock('@assistant-ui/react', async importOriginal => {
  const actual = await importOriginal<typeof import('@assistant-ui/react')>();
  return {
    ...actual,
    useAuiState: (selector: (state: unknown) => unknown) =>
      selector({ threadListItem: { remoteId: 'ses_1' }, thread: { isRunning: threadRunning.current } }),
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

import { ConnectionStatusContainer } from '@/containers/ConnectionStatusContainer.js';
import {
  createStreamDropChannel,
  ForegroundEventSync,
  RECONNECT_GIVE_UP_MS,
  type StreamDropChannel,
} from '@/hooks/useForegroundEventSync.js';
import type { SessionTipInfo } from '@/plugins/trueforge-agent-server-adapter/sessionResync.js';
import { publishBlockedSend } from '@/plugins/trueforge-agent-server-adapter/sessionResync.js';
import { ServerProvider } from '@/server/ServerContext.js';
import { publishStaleApproval } from '@/utils/staleApproval.js';

let hidden = false;
Object.defineProperty(document, 'hidden', {
  configurable: true,
  get: () => hidden,
});

const FOREGROUND_DEBOUNCE_MS = 500;

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
    threadRunning.current = false;
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

  let streamDrops: StreamDropChannel;

  function renderSync() {
    streamDrops = createStreamDropChannel();
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
        <ForegroundEventSync streamDrops={streamDrops}>
          <ConnectionStatusContainer />
        </ForegroundEventSync>
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

  it('swallows a stale refusal while auto-denying and just reloads', async () => {
    peekSessionTip.mockResolvedValue(tipWith({ pendingApprovals: [oldApproval(45)] }));
    dismissPendingApprovals.mockRejectedValue(
      Object.assign(new Error('Status code: 409'), {
        statusCode: 409,
        body: { error: { message: 'stale', type: 'conflict', code: 'stale_approval_continuation' } },
      }),
    );
    renderSync();
    await backgroundThenForeground(60_000);

    expect(dismissPendingApprovals).toHaveBeenCalledTimes(1);
    expect(showError).not.toHaveBeenCalled();
    expect(showSuccess).not.toHaveBeenCalled();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('still reports other auto-deny failures', async () => {
    peekSessionTip.mockResolvedValue(tipWith({ pendingApprovals: [oldApproval(45)] }));
    dismissPendingApprovals.mockRejectedValue(new Error('server unreachable'));
    renderSync();
    await backgroundThenForeground(60_000);

    expect(showError).toHaveBeenCalledTimes(1);
  });

  it('reloads the chat when an approval is refused as stale', () => {
    renderSync();
    act(() => {
      publishStaleApproval();
    });

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does not auto-deny recent approvals, it only surfaces them', async () => {
    peekSessionTip.mockResolvedValue(tipWith({ pendingApprovals: [oldApproval(5)] }));
    renderSync();
    await backgroundThenForeground(60_000);

    expect(dismissPendingApprovals).not.toHaveBeenCalled();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('shows Reconnecting instead of an error when the probe fails, then resyncs once the server answers', async () => {
    peekSessionTip
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValue(tipWith());
    renderSync();
    hidden = true;
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await vi.advanceTimersByTimeAsync(60_000);
    hidden = false;
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FOREGROUND_DEBOUNCE_MS);
    });

    expect(screen.getByRole('status').textContent).toBe('Reconnecting…');
    expect(showError).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(peekSessionTip).toHaveBeenCalledTimes(3);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('status')).toBeNull();
    expect(showError).not.toHaveBeenCalled();
  });

  it('resyncs a dropped reply stream without a page reload', async () => {
    renderSync();
    await act(async () => {
      streamDrops.report();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(peekSessionTip).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('waits for the page to be visible again before reconnecting a stream dropped in the background', async () => {
    renderSync();
    hidden = true;
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await act(async () => {
      streamDrops.report();
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(peekSessionTip).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();

    // A short hide still resyncs: the drop is what is owed, not the hidden time.
    hidden = false;
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FOREGROUND_DEBOUNCE_MS);
    });

    expect(peekSessionTip).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('resyncs when the page comes back from the back-forward cache', async () => {
    renderSync();
    await act(async () => {
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('reloads after a long hide when a reply is still running, so its stream is picked up again', async () => {
    peekSessionTip.mockResolvedValue(tipWith({ status: 'running' }));
    renderSync();
    await backgroundThenForeground(60_000);

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('re-checks a running reply after a short hide, since its stream can die while looking open', async () => {
    threadRunning.current = true;
    peekSessionTip.mockResolvedValue(tipWith({ status: 'running' }));
    renderSync();
    await backgroundThenForeground(6_000);

    expect(peekSessionTip).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('reloads a reply that finished while the page was hidden, so it does not stay shown as running', async () => {
    threadRunning.current = true;
    peekSessionTip.mockResolvedValue(tipWith({ status: 'done' }));
    renderSync();
    await backgroundThenForeground(6_000);

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('starts from the Connection lost state of a failed reload and ends resynced without a page reload', async () => {
    // The first read after a phone wakes can fail before the network is back; the chat reports it
    // as a lost connection and must then resync by itself.
    peekSessionTip.mockRejectedValueOnce(new TypeError('Load failed')).mockResolvedValue(tipWith());
    renderSync();
    await act(async () => {
      streamDrops.report();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByRole('status').textContent).toBe('Reconnecting…');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('status')).toBeNull();
    expect(showError).not.toHaveBeenCalled();
  });

  it('shows one plain next step and Retry after reconnecting fails for a while, and Retry resyncs', async () => {
    peekSessionTip.mockRejectedValue(new TypeError('Failed to fetch'));
    renderSync();
    await act(async () => {
      streamDrops.report();
      await vi.advanceTimersByTimeAsync(RECONNECT_GIVE_UP_MS - 1_000);
    });
    expect(screen.getByRole('status').textContent).toBe('Reconnecting…');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(screen.getByRole('alert').textContent).toContain('Connection lost. Check your network, then tap Retry.');
    const attemptsBeforeGivingUp = peekSessionTip.mock.calls.length;
    expect(attemptsBeforeGivingUp).toBeGreaterThan(2);

    // Once it gave up, it stops trying on its own until the person or the network says so.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(peekSessionTip).toHaveBeenCalledTimes(attemptsBeforeGivingUp);
    expect(reload).not.toHaveBeenCalled();
    expect(showError).not.toHaveBeenCalled();

    peekSessionTip.mockResolvedValue(tipWith());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(reload).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('reconnects as soon as the network comes back after giving up', async () => {
    peekSessionTip.mockRejectedValue(new TypeError('Failed to fetch'));
    renderSync();
    await act(async () => {
      streamDrops.report();
      await vi.advanceTimersByTimeAsync(RECONNECT_GIVE_UP_MS);
    });
    expect(screen.getByRole('alert')).toBeTruthy();

    peekSessionTip.mockResolvedValue(tipWith());
    await act(async () => {
      window.dispatchEvent(new Event('online'));
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(reload).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

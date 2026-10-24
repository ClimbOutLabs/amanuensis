// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@assistant-ui/react', async importOriginal => {
  const actual = await importOriginal<typeof import('@assistant-ui/react')>();
  return {
    ...actual,
    useAuiState: (selector: (state: unknown) => unknown) =>
      selector({ threadListItem: { remoteId: 'ses_1' }, thread: { messages: threadMessages.current } }),
  };
});

const { threadMessages } = vi.hoisted((): { threadMessages: { current: unknown[] } } => ({
  threadMessages: { current: [] },
}));
const reload = vi.fn();
let pendingApprovals: Array<{ approvalId: string }> = [];
vi.mock('@truefoundry/assistant-ui-runtime', () => ({
  useTrueFoundryReload: () => reload,
  useTrueFoundryApprovals: () => ({ pending: pendingApprovals, respond: vi.fn() }),
}));

const showSuccess = vi.fn();
const showError = vi.fn();
vi.mock('@/containers/ToasterContainer.js', () => ({
  useToasterOptional: () => ({ showSuccess, showError }),
}));

import { PendingApprovalsBanner } from '@/containers/PendingApprovalsBanner.js';
import { publishBlockedSend } from '@/plugins/trueforge-agent-server-adapter/sessionResync.js';
import { ServerProvider } from '@/server/ServerContext.js';

function pendingCall(id: string) {
  return { type: 'tool-call', toolCallId: id, toolName: 'bash', approval: { id, approved: undefined } };
}

/** The runtime lists every pending approval; each id is a card on the given message. */
function setPending(...cards: { id: string; onNewest: boolean }[]) {
  pendingApprovals = cards.map(card => ({ approvalId: card.id }));
  threadMessages.current = [
    { role: 'assistant', content: cards.filter(card => !card.onNewest).map(card => pendingCall(card.id)) },
    { role: 'user', content: [] },
    { role: 'assistant', content: cards.filter(card => card.onNewest).map(card => pendingCall(card.id)) },
  ];
}

describe('PendingApprovalsBanner journeys', () => {
  let dismissPendingApprovals: ReturnType<typeof vi.fn>;

  function renderBanner(server: unknown) {
    const withCapabilities = {
      getCapabilities: vi.fn(async () => ({ data: {} })),
      ...(server as Record<string, unknown>),
    };
    return render(
      <ServerProvider server={withCapabilities as never}>
        <PendingApprovalsBanner />
      </ServerProvider>,
    );
  }

  /** The banner shows for a blocked send; the composer strip carries a waiting card instead. */
  function renderBlockedBanner(server: unknown) {
    const result = renderBanner(server);
    act(() => {
      publishBlockedSend();
    });
    return result;
  }

  function fakeServer() {
    dismissPendingApprovals = vi.fn(async () => ({ dismissed: 2, alreadyResolved: false }));
    return { peekSessionTip: vi.fn(), dismissPendingApprovals };
  }

  afterEach(() => {
    threadMessages.current = [];
    pendingApprovals = [];
    reload.mockClear();
    showSuccess.mockClear();
    showError.mockClear();
  });

  it('shows Action needed with the count and dismisses every approval as deny', async () => {
    setPending({ id: 'a1', onNewest: true }, { id: 'a2', onNewest: true });
    const { container } = renderBlockedBanner(fakeServer());

    expect(screen.getByRole('alert')).toHaveTextContent('Action needed');
    expect(screen.getByRole('alert')).toHaveTextContent('2 tool calls');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /dismiss pending approvals/i }));
    });

    expect(dismissPendingApprovals).toHaveBeenCalledTimes(1);
    const [request] = dismissPendingApprovals.mock.calls[0] as [{ sessionId: string; reason: string }];
    expect(request.sessionId).toBe('ses_1');
    expect(reload).toHaveBeenCalledTimes(1);
    expect(showSuccess).toHaveBeenCalledTimes(1);
    // Once the approvals are denied the thread is no longer blocked, so the banner goes.
    expect(container.querySelector('[data-role="host-pending-approvals"]')).toBeNull();
  });

  it('appears immediately when a send is blocked, even before the runtime lists approvals', async () => {
    const { unmount } = renderBanner(fakeServer());
    expect(screen.queryByRole('alert')).toBeNull();

    act(() => {
      publishBlockedSend();
    });

    expect(screen.getByRole('alert')).toHaveTextContent('Action needed');
    expect(screen.getByRole('alert')).toHaveTextContent('could not be sent');
    unmount();
  });

  it('hides the dismiss button when the server has no resync port', () => {
    setPending({ id: 'a1', onNewest: true });
    renderBlockedBanner({ someOther: 'server' });

    expect(screen.getByRole('alert')).toHaveTextContent('Action needed');
    expect(screen.queryByRole('button', { name: /dismiss/i })).toBeNull();
  });

  it('stays hidden while a card waits, because the composer strip carries that signal', () => {
    setPending({ id: 'a1', onNewest: true });
    const { container } = renderBanner(fakeServer());

    expect(container.firstChild).toBeNull();
  });

  it('shows no banner for a card left pending on an older turn', () => {
    setPending({ id: 'old', onNewest: false });
    const { container } = renderBanner(fakeServer());

    expect(container.firstChild).toBeNull();
  });

  it('counts only the approvals on the newest message', () => {
    setPending({ id: 'old', onNewest: false }, { id: 'now', onNewest: true });
    renderBlockedBanner(fakeServer());

    expect(screen.getByRole('alert')).toHaveTextContent('1 tool call');
  });

  it('renders nothing when there is nothing pending and nothing blocked', () => {
    const { container } = renderBanner(fakeServer());
    expect(container.firstChild).toBeNull();
  });

  it('reports a failed dismissal without clearing the banner', async () => {
    setPending({ id: 'a1', onNewest: true });
    dismissPendingApprovals = vi.fn(async () => {
      throw new Error('server unreachable');
    });
    renderBlockedBanner({ dismissPendingApprovals });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /dismiss pending approvals/i }));
    });

    expect(showError).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('alert')).toHaveTextContent('Action needed');
  });

  it('reloads the chat when the dismissal is refused as stale, without raising the error', async () => {
    setPending({ id: 'a1', onNewest: true });
    const stale = Object.assign(new Error('Status code: 409'), {
      statusCode: 409,
      body: { error: { message: 'stale', type: 'conflict', code: 'stale_approval_continuation' } },
    });
    dismissPendingApprovals = vi.fn(async () => {
      throw stale;
    });
    renderBlockedBanner({ dismissPendingApprovals });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /dismiss pending approvals/i }));
    });

    expect(reload).toHaveBeenCalledTimes(1);
    expect(showError).not.toHaveBeenCalled();
  });

  it('reloads without raising the error when the approvals ended while dismissing', async () => {
    setPending({ id: 'a1', onNewest: true });
    const ended = Object.assign(new Error('Status code: 409'), {
      statusCode: 409,
      body: {
        error: {
          message: 'This request ended. Ask again if you still need it.',
          type: 'conflict',
          code: 'approval_request_ended',
        },
      },
    });
    dismissPendingApprovals = vi.fn(async () => {
      throw ended;
    });
    renderBanner({ dismissPendingApprovals });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /dismiss pending approvals/i }));
    });

    expect(reload).toHaveBeenCalledTimes(1);
    expect(showError).not.toHaveBeenCalled();
  });
});

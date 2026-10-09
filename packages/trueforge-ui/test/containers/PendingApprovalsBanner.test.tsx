// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@assistant-ui/react', async importOriginal => {
  const actual = await importOriginal<typeof import('@assistant-ui/react')>();
  return {
    ...actual,
    useAuiState: (selector: (state: unknown) => unknown) => selector({ threadListItem: { remoteId: 'ses_1' } }),
  };
});

const reload = vi.fn();
let pendingApprovals: Array<{ id: string }> = [];
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

  function fakeServer() {
    dismissPendingApprovals = vi.fn(async () => ({ dismissed: 2, alreadyResolved: false }));
    return { peekSessionTip: vi.fn(), dismissPendingApprovals };
  }

  afterEach(() => {
    pendingApprovals = [];
    reload.mockClear();
    showSuccess.mockClear();
    showError.mockClear();
  });

  it('shows Action needed with the count and dismisses every approval as deny', async () => {
    pendingApprovals = [{ id: 'a1' }, { id: 'a2' }];
    const { container } = renderBanner(fakeServer());

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
    expect(container.querySelector('[data-role="host-pending-approvals"]')).not.toBeNull();
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
    pendingApprovals = [{ id: 'a1' }];
    renderBanner({ someOther: 'server' });

    expect(screen.getByRole('alert')).toHaveTextContent('Action needed');
    expect(screen.queryByRole('button', { name: /dismiss/i })).toBeNull();
  });

  it('renders nothing when there is nothing pending and nothing blocked', () => {
    const { container } = renderBanner(fakeServer());
    expect(container.firstChild).toBeNull();
  });

  it('reports a failed dismissal without clearing the banner', async () => {
    pendingApprovals = [{ id: 'a1' }];
    dismissPendingApprovals = vi.fn(async () => {
      throw new Error('server unreachable');
    });
    renderBanner({ dismissPendingApprovals });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /dismiss pending approvals/i }));
    });

    expect(showError).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('alert')).toHaveTextContent('Action needed');
  });
});

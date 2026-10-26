// @vitest-environment jsdom
import { useExternalStoreRuntime, type ThreadMessageLike } from '@assistant-ui/react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMockAgentUIServer } from '../server/mockServer.js';

vi.mock('@truefoundry/assistant-ui-runtime', () => ({
  useTrueFoundryReload: () => vi.fn(),
  trueFoundryAttachmentAdapter: {},
  useTrueFoundryAgentRuntime: () =>
    useExternalStoreRuntime<ThreadMessageLike>({
      messages: [],
      isRunning: false,
      convertMessage: (message: ThreadMessageLike) => message,
      onNew: async () => {},
    }),
  useTrueFoundryCancel: () => vi.fn(),
  useTrueFoundryToolResponses: () => ({ pending: [] }),
  useTrueFoundryApprovals: () => ({ pending: [] }),
  useTrueFoundryRespondToToolApproval: () => vi.fn(),
  useTrueFoundryMcpAuth: () => ({ pending: [], connect: vi.fn(), continue: vi.fn() }),
  useTrueFoundryHistoryPagination: () => ({ isLoadingMore: false, hasMore: false, loadMore: vi.fn() }),
  useTrueFoundryAgentSpec: () => ({ agentSpec: { model: { name: 'openai-main/gpt-4.1' } } }),
  useTrueFoundryFlushAgentSpec: () => async () => {},
  useTrueFoundryAdoptAgentSpec: () => vi.fn(),
  useTrueFoundryUpdateAgentSpec: () => vi.fn(),
}));

vi.mock('thinking-orbs', () => ({
  ThinkingOrb: () => <div data-testid="thinking-orb" />,
}));

import { BugReportButton } from '@/atoms/BugReportButton.js';
import { BugReportProvider, type BugReportApi } from '@/components/BugReportContext.js';
import { TrueForgeUI, type ChatLayout } from '@/containers/TrueForgeUI.js';

const getBugReportHandoff = vi.fn(() => Promise.resolve(null));
const api: BugReportApi = {
  generateBugReport: () => Promise.reject(new Error('not used')),
  generateAppBugReport: () => Promise.reject(new Error('not used')),
  getBugReportHandoff,
};

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
});

afterEach(() => {
  getBugReportHandoff.mockClear();
});

function CustomLayout() {
  return (
    <div data-testid="custom-layout">
      <BugReportButton />
    </div>
  );
}

function renderShell({
  layout,
  withProvider = true,
}: {
  layout: ChatLayout | typeof CustomLayout;
  withProvider?: boolean;
}) {
  const ui = (
    <TrueForgeUI
      server={createMockAgentUIServer()}
      agentConfig={{ mode: 'SingleAgent', name: 'my-agent' }}
      layout={layout}
      className="h-96"
    />
  );
  return render(withProvider ? <BugReportProvider api={api}>{ui}</BugReportProvider> : ui);
}

describe('bug report dialog in the app shell', () => {
  it('opens from the exported button inside a custom layout', async () => {
    renderShell({ layout: CustomLayout });

    fireEvent.click(await screen.findByRole('button', { name: 'Report a bug' }));

    expect(await screen.findByRole('dialog', { name: 'Report a bug' })).toHaveAttribute('open');
  });

  it('shows neither a button nor a dialog without a provider', async () => {
    renderShell({ layout: CustomLayout, withProvider: false });

    await screen.findByTestId('custom-layout');
    expect(screen.queryByRole('button', { name: 'Report a bug' })).not.toBeInTheDocument();
    expect(document.querySelector('dialog[aria-label="Report a bug"]')).toBeNull();
  });

  it.each(['drawer', 'dock', 'widget'] as const)('opens from the header icon in layout=%s', async layout => {
    renderShell({ layout });
    await act(async () => {
      await vi.dynamicImportSettled();
    });
    if (layout === 'widget') {
      fireEvent.click(await screen.findByRole('button', { name: 'Open chat' }));
    }

    fireEvent.click(await screen.findByRole('button', { name: 'Report a bug' }));

    expect(await screen.findByRole('dialog', { name: 'Report a bug' })).toHaveAttribute('open');
    expect(document.querySelectorAll('dialog[aria-label="Report a bug"]')).toHaveLength(1);
  });

  it('mounts exactly one dialog when a custom layout renders several buttons', async () => {
    function TwoButtons() {
      return (
        <>
          <BugReportButton />
          <BugReportButton />
        </>
      );
    }
    renderShell({ layout: TwoButtons });

    const [first] = await screen.findAllByRole('button', { name: 'Report a bug' });
    if (first === undefined) throw new Error('no Report a bug button');
    fireEvent.click(first);

    await screen.findByRole('dialog', { name: 'Report a bug' });
    expect(document.querySelectorAll('dialog[aria-label="Report a bug"]')).toHaveLength(1);
    expect(within(document.body).getAllByRole('dialog', { name: 'Report a bug' })).toHaveLength(1);
  });

  it('keeps the dialog closed when the widget is closed and opened again', async () => {
    renderShell({ layout: 'widget' });
    fireEvent.click(await screen.findByRole('button', { name: 'Open chat' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Report a bug' }));
    const dialog = await screen.findByRole('dialog', { name: 'Report a bug' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(document.querySelector('dialog[open][aria-label="Report a bug"]')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'Close chat' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open chat' }));

    expect(document.querySelector('dialog[open][aria-label="Report a bug"]')).toBeNull();
  });
});

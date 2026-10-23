// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RepositoryWorkProvider, type RepositoryWorkApi } from '@/components/RepositoryWorkContext.js';
import { ThreadWorkOnRepoControls } from '@/containers/WorkOnRepoControls.js';
import { useOptionalWorkOnRepoPanel, WorkOnRepoPanelProvider } from '@/containers/workOnRepoPanel.js';
import type { AgentSpec } from '@/server/types.js';

type DraftState = { agentSpec: AgentSpec | null; isSpecLoading: boolean; specError: unknown };

const runtime = vi.hoisted((): { draft: DraftState; sandboxEnabled: boolean } => ({
  draft: { agentSpec: null, isSpecLoading: false, specError: null },
  sandboxEnabled: true,
}));

vi.mock('@truefoundry/assistant-ui-runtime', () => ({
  useTrueFoundryAgentSpec: () => runtime.draft,
}));
vi.mock('@assistant-ui/react', () => ({ useAui: () => ({}) }));
vi.mock('@assistant-ui/core/react', () => ({ useThreadIsRunning: () => false }));
vi.mock('@/assistant-ui.js', () => ({ useAuiState: () => undefined }));
vi.mock('@/server/ServerContext.js', () => ({
  useServerCapabilities: () => ({ sandbox: { enabled: runtime.sandboxEnabled } }),
}));

const SANDBOX_OFF_LINE =
  'Work on a repo needs the sandbox. Open Add-ons in the composer, go to Connectors, and turn on Sandbox.';

function fakeApi(): RepositoryWorkApi {
  return {
    listGithubRepositories: vi.fn().mockResolvedValue([]),
    getGithubRepository: vi.fn(),
    startRepositoryWork: vi.fn(),
    getSessionRepository: vi.fn(),
    getRepository: vi.fn(),
    listCommandProposals: vi.fn().mockResolvedValue([]),
    confirmCommandProposal: vi.fn(),
    dismissCommandProposal: vi.fn(),
    unbindSessionRepository: vi.fn(),
  };
}

/** Stands in for the composer's + menu item, which opens the panel. */
function OpenPanelButton() {
  const panel = useOptionalWorkOnRepoPanel();
  return (
    <button type="button" onClick={() => panel?.setPanelOpen(true)}>
      Work on a repo
    </button>
  );
}

function renderThreadControls(draft: DraftState) {
  runtime.draft = draft;
  return render(
    <RepositoryWorkProvider api={fakeApi()}>
      <WorkOnRepoPanelProvider>
        <OpenPanelButton />
        <ThreadWorkOnRepoControls />
      </WorkOnRepoPanelProvider>
    </RepositoryWorkProvider>,
  );
}

function expectPanelReady() {
  fireEvent.click(screen.getByRole('button', { name: /work on a repo/i }));
  expect(screen.queryByText(SANDBOX_OFF_LINE)).not.toBeInTheDocument();
}

describe('ThreadWorkOnRepoControls sandbox state', () => {
  beforeEach(() => {
    runtime.sandboxEnabled = true;
  });

  it('stays ready while a reopened chat is still loading its saved settings', () => {
    // After a reload the runtime holds the New Chat seed, which never carries runtime config, until the chat loads.
    renderThreadControls({ agentSpec: { model: { name: 'm' } }, isSpecLoading: true, specError: null });
    expectPanelReady();
  });

  it('stays ready when a reopened chat could not load its settings', () => {
    renderThreadControls({
      agentSpec: { model: { name: 'm' } },
      isSpecLoading: false,
      specError: new Error('offline'),
    });
    expectPanelReady();
  });

  it('stays ready in a saved agent or persona chat, which has no editable settings here', () => {
    renderThreadControls({ agentSpec: null, isSpecLoading: false, specError: null });
    expectPanelReady();
  });

  it('stays ready in a new chat with default settings on a server whose sandbox is on', () => {
    renderThreadControls({
      agentSpec: { model: { name: 'm' }, skills: [{ name: 'web-artifacts-builder' }] },
      isSpecLoading: false,
      specError: null,
    });
    expectPanelReady();
  });

  it('stays ready in a chat that runs with the sandbox on', () => {
    renderThreadControls({
      agentSpec: { model: { name: 'm' }, config: { sandbox: { enabled: true } } },
      isSpecLoading: false,
      specError: null,
    });
    expectPanelReady();
  });

  it('says how to turn the sandbox on when this chat has it off', () => {
    renderThreadControls({
      agentSpec: { model: { name: 'm' }, config: { sandbox: { enabled: false } } },
      isSpecLoading: false,
      specError: null,
    });
    fireEvent.click(screen.getByRole('button', { name: /work on a repo/i }));
    expect(screen.getByText(SANDBOX_OFF_LINE)).toBeInTheDocument();
  });

  it('is left out when the server has no sandbox', () => {
    runtime.sandboxEnabled = false;
    runtime.draft = { agentSpec: null, isSpecLoading: false, specError: null };
    const { container } = render(
      <RepositoryWorkProvider api={fakeApi()}>
        <WorkOnRepoPanelProvider>
          <ThreadWorkOnRepoControls />
        </WorkOnRepoPanelProvider>
      </RepositoryWorkProvider>,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

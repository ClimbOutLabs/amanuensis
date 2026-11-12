// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { useLayoutEffect, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DraftCatalogProvider } from '@/atoms/draft/DraftCatalogProvider.js';
import { DraftComposerLeftSection, DraftComposerRightSection } from '@/atoms/draft/DraftComposerSections.js';
import { CompactLayoutProvider } from '@/atoms/lib/CompactLayoutContext.js';
import { readPrivateChatState, setPendingPrivateChat } from '@/server/privateChatStore.js';
import { ServerProvider } from '@/server/ServerContext.js';
import { ShellModeProvider, useShellMode } from '@/server/ShellModeContext.js';
import type { AgentSpec } from '@/server/types.js';
import { RuntimeHarness } from '../../containers/RuntimeHarness.js';
import { createMockAgentUIServer } from '../../server/mockServer.js';

let agentSpec: AgentSpec;
const updateAgentSpec = vi.fn();

vi.mock('@truefoundry/assistant-ui-runtime', () => ({
  useTrueFoundryAgentSpec: () => ({ agentSpec }),
  useTrueFoundryUpdateAgentSpec: () => updateAgentSpec,
}));

function DraftSections({
  onAttach,
  disabled = false,
  isRunning = false,
  remoteId,
}: {
  onAttach?: () => void;
  disabled?: boolean;
  isRunning?: boolean;
  remoteId?: string;
}) {
  const server = createMockAgentUIServer({
    getModels: async () => [
      {
        id: 'gpt-4.1',
        name: 'openai/gpt-4.1',
        provider: { name: 'OpenAI' },
        properties: { reasoningEfforts: ['low', 'high'] },
      },
    ],
  });

  return (
    <ServerProvider server={server}>
      <RuntimeHarness messages={[]} {...(remoteId === undefined ? {} : { threadId: 't1', remoteId })}>
        <DraftCatalogProvider>
          <DraftComposerLeftSection disabled={disabled} isRunning={isRunning} onAttach={onAttach} />
          <DraftComposerRightSection disabled={disabled} isRunning={isRunning} />
        </DraftCatalogProvider>
      </RuntimeHarness>
    </ServerProvider>
  );
}

function BuilderMode({ children }: { children: ReactNode }) {
  const { openAgentBuilder } = useShellMode();
  useLayoutEffect(() => {
    openAgentBuilder();
  }, [openAgentBuilder]);
  return children;
}

function AgentConfigState() {
  const { agentConfigOpen } = useShellMode();
  return <span>{agentConfigOpen ? 'Config open' : 'Config closed'}</span>;
}

describe('draft composer sections', () => {
  beforeEach(() => {
    agentSpec = {
      model: { name: 'openai/gpt-4.1', params: { reasoningEffort: 'high' } },
      mcpServers: [{ id: 'github', name: 'GitHub' }],
      skills: [
        { id: 'research', name: 'Research' },
        { id: 'writer', name: 'Writer' },
      ],
    };
    updateAgentSpec.mockReset();
    setPendingPrivateChat(false);
  });

  it('offers Incognito chat on a new chat, and pressing it chooses Incognito for that chat', () => {
    render(<DraftSections />);

    const choice = screen.getByRole('button', { name: 'Start incognito chat' });
    expect(choice).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(choice);
    expect(choice).toHaveAttribute('aria-pressed', 'true');
    expect(readPrivateChatState().pending).toBe(true);
  });

  it('does not offer Incognito chat once the chat has started', () => {
    render(<DraftSections remoteId="ses_started" />);

    expect(screen.queryByRole('button', { name: 'Start incognito chat' })).not.toBeInTheDocument();
  });

  it('leaves Incognito chat out of the builder composer', () => {
    render(
      <ShellModeProvider agentConfig={{ mode: 'AgentComposer' }}>
        <BuilderMode>
          <DraftSections />
        </BuilderMode>
      </ShellModeProvider>,
    );

    expect(screen.queryByRole('button', { name: 'Start incognito chat' })).not.toBeInTheDocument();
  });

  it('puts attaching and add-ons in one plus menu, with no standalone attach or add-ons control', async () => {
    const onAttach = vi.fn();
    render(<DraftSections onAttach={onAttach} />);

    expect(screen.queryByRole('button', { name: 'Attach a file' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Add-ons \(\d+\)/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Attach files' }));
    expect(onAttach).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByRole('menuitem', { name: 'Add-ons' })).toBeInTheDocument();
  });

  it('shows the model as plain text and puts reasoning effort inside its menu', async () => {
    render(<DraftSections />);

    const model = await screen.findByTitle('Select model');
    expect(model).toHaveTextContent('gpt-4.1');
    expect(screen.queryByTitle('Select reasoning effort')).not.toBeInTheDocument();

    fireEvent.click(model);
    fireEvent.click(await screen.findByRole('option', { name: 'low' }));

    expect(updateAgentSpec).toHaveBeenCalledWith({
      model: expect.objectContaining({
        name: 'openai/gpt-4.1',
        params: expect.objectContaining({ reasoningEffort: 'low' }),
      }),
    });
  });

  it('groups the model and voice controls so narrow screens can restack them', async () => {
    render(<DraftSections />);

    const model = await screen.findByTitle('Select model');
    const selector = model.closest('.aui-composer-model-selector');
    expect(selector?.parentElement).toHaveClass('aui-composer-right-group');
  });

  it('leaves the model control out of the builder composer', () => {
    render(
      <ShellModeProvider agentConfig={{ mode: 'AgentComposer' }}>
        <BuilderMode>
          <DraftSections />
        </BuilderMode>
      </ShellModeProvider>,
    );

    expect(screen.queryByTitle('Select model')).not.toBeInTheDocument();
  });

  it('shows the Agent config entry only in compact builder layouts', () => {
    const onAttach = vi.fn();
    const { rerender } = render(
      <ShellModeProvider agentConfig={{ mode: 'AgentComposer' }}>
        <BuilderMode>
          <DraftSections />
        </BuilderMode>
      </ShellModeProvider>,
    );

    expect(screen.queryByRole('button', { name: 'Agent config' })).not.toBeInTheDocument();

    rerender(
      <ShellModeProvider agentConfig={{ mode: 'AgentComposer' }}>
        <BuilderMode>
          <CompactLayoutProvider>
            <DraftSections onAttach={onAttach} />
            <AgentConfigState />
          </CompactLayoutProvider>
        </BuilderMode>
      </ShellModeProvider>,
    );

    expect(screen.queryByRole('button', { name: 'Attach a file' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByRole('menuitem', { name: 'Agent config' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Attach files' }));
    expect(onAttach).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Agent config' }));
    expect(screen.getByText('Config open')).toBeInTheDocument();
  });

  it('propagates disabled state to the plus menu and model, and hides the model while running', async () => {
    const { rerender } = render(<DraftSections disabled />);

    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
    expect(await screen.findByTitle('Select model')).toBeDisabled();

    rerender(<DraftSections isRunning />);
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
    expect(screen.queryByTitle('Select model')).not.toBeInTheDocument();
  });
});

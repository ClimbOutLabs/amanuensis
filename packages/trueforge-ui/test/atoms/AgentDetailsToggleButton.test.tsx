// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { AgentDetailsToggleButton } from '@/atoms/AgentDetailsToggleButton.js';
import { ClearChatButton } from '@/atoms/ClearChatButton.js';
import { AgentDetailsPreferenceProvider } from '@/server/AgentDetailsPreferenceContext.js';
import { ServerProvider } from '@/server/ServerContext.js';
import { ShellModeProvider } from '@/server/ShellModeContext.js';
import { SlotsProvider } from '@/theme/SlotsProvider.js';
import { RuntimeHarness } from '../containers/RuntimeHarness.js';
import { createMockAgentUIServer } from '../server/mockServer.js';

vi.mock('@truefoundry/assistant-ui-runtime', () => ({
  useTrueFoundryAgentSpec: () => ({
    agentSpec: { model: { name: 'openai-main/gpt-4.1' } },
  }),
}));

const startedMessages = [{ role: 'user' as const, content: 'hello', id: 'm1' }];

function renderToggle({ agentDetails }: { agentDetails: 'expanded' | 'collapsed' }) {
  const session = {
    id: 'sess-1',
    isMutable: true,
    createdAt: '2026-08-03T00:00:00.000Z',
    updatedAt: '2026-08-03T00:00:00.000Z',
    metadata: { agent_details: agentDetails },
  };
  const server = createMockAgentUIServer({
    getSession: vi.fn(async () => session),
    updateSession: vi.fn(async () => session),
  });

  return {
    server,
    ...render(
      <SlotsProvider>
        <ServerProvider server={server}>
          <AgentDetailsPreferenceProvider>
            <ShellModeProvider agentConfig={{ mode: 'SingleAgent', name: 'a' }}>
              <RuntimeHarness messages={startedMessages} threadId="t1" remoteId="sess-1">
                <ClearChatButton />
                <AgentDetailsToggleButton />
              </RuntimeHarness>
            </ShellModeProvider>
          </AgentDetailsPreferenceProvider>
        </ServerProvider>
      </SlotsProvider>,
    ),
  };
}

describe('AgentDetailsToggleButton', () => {
  it('is hidden while idle / on a fresh chat, same rule as Clear chat', () => {
    render(
      <SlotsProvider>
        <ShellModeProvider agentConfig={{ mode: 'AgentLibrary' }}>
          <RuntimeHarness messages={[]}>
            <AgentDetailsToggleButton />
          </RuntimeHarness>
        </ShellModeProvider>
      </SlotsProvider>,
    );
    expect(screen.queryByRole('button', { name: /agent details/i })).not.toBeInTheDocument();
  });

  it('is hidden while the chat has no server session id yet', () => {
    render(
      <SlotsProvider>
        <ShellModeProvider agentConfig={{ mode: 'SingleAgent', name: 'a' }}>
          <RuntimeHarness messages={startedMessages}>
            <ClearChatButton />
            <AgentDetailsToggleButton />
          </RuntimeHarness>
        </ShellModeProvider>
      </SlotsProvider>,
    );
    expect(screen.getByRole('button', { name: 'Clear chat' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /agent details/i })).not.toBeInTheDocument();
  });

  it('renders next to Clear chat, labeled "Show agent details" and unpressed when collapsed', async () => {
    renderToggle({ agentDetails: 'collapsed' });
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByRole('button', { name: 'Clear chat' })).toBeInTheDocument();
    const toggle = screen.getByRole('button', { name: 'Show agent details' });
    expect(toggle).toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
  });

  it('renders as "Hide agent details" and pressed when the stored preference is expanded', async () => {
    renderToggle({ agentDetails: 'expanded' });
    await act(async () => {
      await Promise.resolve();
    });

    const toggle = screen.getByRole('button', { name: 'Hide agent details' });
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
  });

  it('toggles the label/aria-pressed and writes the new preference through the session', async () => {
    const { server } = renderToggle({ agentDetails: 'collapsed' });
    await act(async () => {
      await Promise.resolve();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Show agent details' }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByRole('button', { name: 'Hide agent details' })).toHaveAttribute('aria-pressed', 'true');
    expect(server.updateSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess-1',
        metadata: expect.objectContaining({ agent_details: 'expanded' }),
      }),
    );
  });
});

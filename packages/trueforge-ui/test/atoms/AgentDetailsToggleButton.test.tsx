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
    expect(screen.queryByRole('switch', { name: 'Agent details' })).not.toBeInTheDocument();
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
    expect(screen.getByRole('menuitem', { name: 'Clear chat' })).toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: 'Agent details' })).not.toBeInTheDocument();
  });

  it('is a switch labelled "Agent details" that reports off to screen readers', async () => {
    renderToggle({ agentDetails: 'collapsed' });
    await act(async () => {
      await Promise.resolve();
    });

    const toggle = screen.getByRole('switch', { name: 'Agent details' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(toggle).toHaveAttribute('title', 'Agent details are off');
    expect(toggle).toHaveTextContent('Agent details');
  });

  it('reports on, from the preference stored on the chat, so it is the same after a reload', async () => {
    renderToggle({ agentDetails: 'expanded' });
    await act(async () => {
      await Promise.resolve();
    });

    const toggle = screen.getByRole('switch', { name: 'Agent details' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(toggle).toHaveAttribute('title', 'Agent details are on');
    expect(toggle.querySelector('[data-state]')).toHaveAttribute('data-state', 'on');
  });

  it('flips its state and stores the new choice on the chat', async () => {
    const { server } = renderToggle({ agentDetails: 'collapsed' });
    await act(async () => {
      await Promise.resolve();
    });

    fireEvent.click(screen.getByRole('switch', { name: 'Agent details' }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByRole('switch', { name: 'Agent details' })).toHaveAttribute('aria-checked', 'true');
    expect(server.updateSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess-1',
        metadata: expect.objectContaining({ agent_details: 'expanded' }),
      }),
    );
  });
});

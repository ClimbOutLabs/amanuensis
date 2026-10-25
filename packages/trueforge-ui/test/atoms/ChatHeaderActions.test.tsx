// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { AgentDetailsToggleButton } from '@/atoms/AgentDetailsToggleButton.js';
import { ChatHeaderMenu } from '@/atoms/ChatHeaderMenu.js';
import { headerActionClassName } from '@/atoms/lib/buttonClasses.js';
import { PageHeader } from '@/atoms/PageHeader.js';
import { HelpProvider, type HelpApi } from '@/help/HelpProvider.js';
import { AgentDetailsPreferenceProvider } from '@/server/AgentDetailsPreferenceContext.js';
import { ServerProvider } from '@/server/ServerContext.js';
import { ShellModeProvider } from '@/server/ShellModeContext.js';
import { SlotsProvider } from '@/theme/SlotsProvider.js';
import { RuntimeHarness } from '../containers/RuntimeHarness.js';
import { createMockAgentUIServer } from '../server/mockServer.js';

vi.mock('@truefoundry/assistant-ui-runtime', () => ({
  useTrueFoundryAgentSpec: () => ({ agentSpec: { model: { name: 'openai-main/gpt-4.1' } } }),
}));

const HELP_API: HelpApi = {
  getHealthCheck: () => Promise.reject(new Error('not used here')),
  ensureGuide: () => Promise.resolve(false),
};

function renderChatHeader({ overrides }: { overrides?: Parameters<typeof SlotsProvider>[0]['overrides'] } = {}) {
  const session = {
    id: 'sess-1',
    isMutable: true,
    createdAt: '2026-08-03T00:00:00.000Z',
    updatedAt: '2026-08-03T00:00:00.000Z',
    metadata: { agent_details: 'collapsed' },
  };
  const server = createMockAgentUIServer({
    getSession: vi.fn(async () => session),
    updateSession: vi.fn(async () => session),
  });
  return render(
    <SlotsProvider overrides={overrides}>
      <HelpProvider api={HELP_API}>
        <ServerProvider server={server}>
          <AgentDetailsPreferenceProvider>
            <ShellModeProvider agentConfig={{ mode: 'SingleAgent', name: 'a' }}>
              <RuntimeHarness messages={[{ role: 'user', content: 'hello', id: 'm1' }]} threadId="t1" remoteId="sess-1">
                <PageHeader helpAction singleLine end={<AgentDetailsToggleButton />} menu={<ChatHeaderMenu />} />
              </RuntimeHarness>
            </ShellModeProvider>
          </AgentDetailsPreferenceProvider>
        </ServerProvider>
      </HelpProvider>
    </SlotsProvider>,
  );
}

describe('chat header actions', () => {
  it('share one plain style, with no box on any of them', async () => {
    renderChatHeader();
    await act(async () => {
      await Promise.resolve();
    });

    const header = screen.getByRole('banner');
    const actions = Array.from(header.querySelectorAll('button'));
    expect(actions.map(action => action.getAttribute('aria-label') ?? action.textContent?.trim())).toEqual([
      'Agent details',
      "Help, I'm stuck",
      'Chat actions',
    ]);
    for (const action of actions) {
      expect(action.className).toBe(headerActionClassName);
      expect(action).toHaveClass('border-0', 'bg-transparent');
    }
  });

  it('keeps Clear chat out of the header, in its three-dots menu', async () => {
    renderChatHeader();
    await act(async () => {
      await Promise.resolve();
    });

    const header = screen.getByRole('banner');
    expect(within(header).queryByText('Clear chat')).not.toBeInTheDocument();
    fireEvent.click(within(header).getByRole('button', { name: 'Chat actions' }));
    expect(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Clear chat' })).toBeInTheDocument();
  });

  it('shows a host override of Clear chat in the menu', async () => {
    renderChatHeader({
      overrides: {
        ClearChatButton: () => (
          <button type="button" role="menuitem">
            custom clear
          </button>
        ),
      },
    });
    await act(async () => {
      await Promise.resolve();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Chat actions' }));
    expect(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'custom clear' })).toBeInTheDocument();
  });

  it('keeps every action on one line', () => {
    renderChatHeader();
    const header = screen.getByRole('banner');
    expect(header).toHaveClass('flex-nowrap');
    expect(header).not.toHaveClass('flex-wrap');
  });
});

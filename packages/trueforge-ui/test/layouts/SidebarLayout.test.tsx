// @vitest-environment jsdom
import { BugReportDialog } from '@/atoms/BugReportButton.js';
import { AgentConfigInstructionsProvider } from '@/atoms/draft/AgentConfigInstructionsContext.js';
import { BugReportProvider, type BugReportApi } from '@/components/BugReportContext.js';
import { SidebarLayout } from '@/layouts/SidebarLayout.js';
import { ServerProvider } from '@/server/ServerContext.js';
import { ShellModeProvider, useShellMode } from '@/server/ShellModeContext.js';
import { SpaceProvider, type SpaceStore } from '@/server/SpaceContext.js';
import { SlotsProvider } from '@/theme/SlotsProvider.js';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { noSpaceFolders } from '../server/noSpaceFolders.js';

import { RuntimeHarness } from '../containers/RuntimeHarness.js';
import { createMockAgentUIServer, createMockCatalog, createMockScheduleServer } from '../server/mockServer.js';

const HISTORY_COLLAPSED_STORAGE_KEY = 'aui-history-collapsed';

function mockServer() {
  return createMockAgentUIServer({ catalog: createMockCatalog() });
}

/** Shows the chat runtime's key, which changes whenever a fresh chat starts. */
function RuntimeKeyProbe() {
  const shell = useShellMode();
  return <output data-testid="runtime-key">{shell.runtimeKey}</output>;
}

/** Renders SidebarLayout with an active, non-builder mutable chat, so the recent-history
 *  panel (and its toggle) are eligible to show. */
function renderSidebarLayout() {
  return render(
    <SlotsProvider>
      <ServerProvider server={mockServer()}>
        <ShellModeProvider>
          <AgentConfigInstructionsProvider>
            <RuntimeHarness messages={[]}>
              <RuntimeKeyProbe />
              <div className="h-96">
                <SidebarLayout />
              </div>
            </RuntimeHarness>
          </AgentConfigInstructionsProvider>
        </ShellModeProvider>
      </ServerProvider>
    </SlotsProvider>,
  );
}

/** Renders SidebarLayout in New Agent builder mode, where the recent-history panel is
 *  never eligible to show. */
function renderSidebarLayoutInAgentBuilder() {
  function OpenAgentBuilderButton() {
    const shell = useShellMode();
    return (
      <button type="button" onClick={() => shell.openAgentBuilder()}>
        Open agent builder
      </button>
    );
  }

  return render(
    <SlotsProvider>
      <ServerProvider server={mockServer()}>
        <ShellModeProvider>
          <AgentConfigInstructionsProvider>
            <RuntimeHarness messages={[]}>
              <OpenAgentBuilderButton />
              <div className="h-96">
                <SidebarLayout />
              </div>
            </RuntimeHarness>
          </AgentConfigInstructionsProvider>
        </ShellModeProvider>
      </ServerProvider>
    </SlotsProvider>,
  );
}

describe('SidebarLayout Chats entry', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('shows one Chats entry that opens and closes the chat list, and never a New entry', async () => {
    renderSidebarLayout();
    const nav = screen.getByRole('navigation', { name: 'Sidebar' });

    expect(within(nav).queryByText('New')).not.toBeInTheDocument();
    expect(within(nav).queryByRole('button', { name: /new chat/i })).not.toBeInTheDocument();
    const chats = within(nav).getByRole('button', { name: 'Chats' });
    expect(chats).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('complementary', { name: 'Recent chats' })).toBeInTheDocument();

    fireEvent.click(chats);
    await waitFor(() => {
      expect(screen.queryByRole('complementary', { name: 'Recent chats' })).not.toBeInTheDocument();
    });
    expect(chats).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(chats);
    expect(await screen.findByRole('complementary', { name: 'Recent chats' })).toBeInTheDocument();
    expect(chats).toHaveAttribute('aria-expanded', 'true');
  });

  it('puts New chat at the top of the chat list, and it starts a chat and closes the list opened from the rail', async () => {
    renderSidebarLayout();
    fireEvent.click(screen.getByRole('button', { name: 'Chats' }));
    await waitFor(() => {
      expect(screen.queryByRole('complementary', { name: 'Recent chats' })).not.toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Chats' }));
    const list = await screen.findByRole('complementary', { name: 'Recent chats' });

    const newChat = within(list).getByRole('button', { name: 'New chat' });
    expect(within(list).getAllByRole('button')[0]).toBe(newChat);
    const chatBefore = screen.getByTestId('runtime-key').textContent;
    fireEvent.click(newChat);

    await waitFor(() => {
      expect(screen.queryByRole('complementary', { name: 'Recent chats' })).not.toBeInTheDocument();
    });
    expect(screen.getByTestId('runtime-key').textContent).not.toBe(chatBefore);
  });

  it('closes the list opened from the rail on a press outside, without pressing what is under it', async () => {
    const pressed = vi.fn();
    render(
      <>
        <button type="button" onClick={pressed}>
          Under the pointer
        </button>
        <div />
      </>,
    );
    renderSidebarLayout();
    fireEvent.click(screen.getByRole('button', { name: 'Chats' }));
    fireEvent.click(screen.getByRole('button', { name: 'Chats' }));
    await screen.findByRole('complementary', { name: 'Recent chats' });

    const outside = screen.getByRole('button', { name: 'Under the pointer' });
    fireEvent.pointerDown(outside);
    fireEvent.mouseDown(outside);
    fireEvent.click(outside);

    await waitFor(() => {
      expect(screen.queryByRole('complementary', { name: 'Recent chats' })).not.toBeInTheDocument();
    });
    expect(pressed).not.toHaveBeenCalled();
    // The next press is an ordinary one again.
    fireEvent.click(outside);
    expect(pressed).toHaveBeenCalledTimes(1);
  });

  it('keeps the list open on a press inside it, and closes it on Escape', async () => {
    renderSidebarLayout();
    fireEvent.click(screen.getByRole('button', { name: 'Chats' }));
    fireEvent.click(screen.getByRole('button', { name: 'Chats' }));
    const list = await screen.findByRole('complementary', { name: 'Recent chats' });

    fireEvent.pointerDown(within(list).getByRole('button', { name: 'Search chats' }));
    expect(screen.getByRole('complementary', { name: 'Recent chats' })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('complementary', { name: 'Recent chats' })).not.toBeInTheDocument();
    });
  });

  it('remembers a closed list across a remount', async () => {
    const { unmount } = renderSidebarLayout();

    fireEvent.click(screen.getByRole('button', { name: 'Chats' }));
    await waitFor(() => {
      expect(localStorage.getItem(HISTORY_COLLAPSED_STORAGE_KEY)).toBe('true');
    });

    unmount();
    renderSidebarLayout();

    expect(screen.queryByRole('complementary', { name: 'Recent chats' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Chats' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('leaves the agent builder for a chat with the list open when Chats is pressed', async () => {
    renderSidebarLayoutInAgentBuilder();

    fireEvent.click(screen.getByRole('button', { name: 'Open agent builder' }));
    await waitFor(() => {
      expect(screen.queryByRole('complementary', { name: 'Recent chats' })).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Chats' }));
    expect(await screen.findByRole('complementary', { name: 'Recent chats' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Agent Config' })).not.toBeInTheDocument();
  });

  it('reveals the chat list inside the mobile drawer without closing it', async () => {
    renderSidebarLayout();

    fireEvent.click(screen.getByRole('button', { name: 'Chats' }));
    await waitFor(() => {
      expect(screen.queryByRole('complementary', { name: 'Recent chats' })).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Navigation' }));
    const dialog = await screen.findByRole('dialog', { name: 'Navigation' });

    // Chats must not dismiss the drawer (the rail's onNavigate bubble handler closes it on any
    // other button click) and must reveal the list.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Chats' }));

    await waitFor(() => {
      expect(
        within(screen.getByRole('dialog', { name: 'Navigation' })).getByRole('complementary', {
          name: 'Recent chats',
        }),
      ).toBeInTheDocument();
    });
  });
});

function mockSpaceStore(): SpaceStore {
  return {
    list: vi.fn(async () => []),
    get: vi.fn(async () => {
      throw new Error('not found');
    }),
    delete: vi.fn(async () => {}),
    ...noSpaceFolders,
  };
}

const bugReportApi: BugReportApi = {
  generateBugReport: () => Promise.reject(new Error('not used')),
  generateAppBugReport: () => Promise.reject(new Error('not used')),
  getBugReportHandoff: () => Promise.reject(new Error('not used')),
};

/** Same as `renderSidebarLayout`, plus a `SpaceProvider` so the Spaces nav button renders
 *  (it renders nothing without one — see `SpacesButton`). With `withBugReport` it also mounts the
 *  bug report dialog, as the app shell does. */
function renderSidebarLayoutWithSpaces({
  withBugReport = false,
  withLibrary = false,
}: { withBugReport?: boolean; withLibrary?: boolean } = {}) {
  const layout = (
    <SlotsProvider>
      <ServerProvider server={mockServer()}>
        <ShellModeProvider {...(withLibrary ? { agentConfig: { mode: 'AgentLibraryWithComposer' as const } } : {})}>
          <SpaceProvider store={mockSpaceStore()}>
            <AgentConfigInstructionsProvider>
              <RuntimeHarness messages={[]}>
                <div className="h-96">
                  <SidebarLayout />
                </div>
                {withBugReport ? <BugReportDialog /> : null}
              </RuntimeHarness>
            </AgentConfigInstructionsProvider>
          </SpaceProvider>
        </ShellModeProvider>
      </ServerProvider>
    </SlotsProvider>
  );
  return render(withBugReport ? <BugReportProvider api={bugReportApi}>{layout}</BugReportProvider> : layout);
}

describe('SidebarLayout rail layout', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('lists Chats and Spaces in order, with the avatar and More together at the bottom', () => {
    renderSidebarLayoutWithSpaces();

    const nav = screen.getByRole('navigation', { name: 'Sidebar' });
    expect(nav).toHaveClass('overflow-y-auto', 'min-h-0', 'flex-col');
    const buttons = Array.from(nav.querySelectorAll('button'));
    const labelOf = (button: HTMLButtonElement) =>
      button.getAttribute('aria-label') ?? button.textContent?.trim() ?? '';
    const order = ['Chats', 'Spaces', 'More'];
    const positions = order.map(label => buttons.findIndex(button => labelOf(button) === label));

    expect(positions.every(position => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(buttons[0]).toBe(screen.getByRole('button', { name: 'Chats' }));
    const more = screen.getByRole('button', { name: 'More' });
    expect(buttons[buttons.length - 1]).toBe(more);

    // The footer group is pushed to the bottom of the rail, and nothing is laid over anything else.
    const footer = more.closest('div.mt-auto');
    expect(footer?.parentElement).toBe(nav);
    for (const el of [nav, ...buttons]) {
      expect(el).not.toHaveStyle({ position: 'absolute' });
    }
  });
});

describe('SidebarLayout rail highlight', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('highlights exactly one entry on every rail screen, the parent for a page inside another', async () => {
    render(
      <SlotsProvider>
        <ServerProvider
          server={createMockAgentUIServer({ catalog: createMockCatalog(), schedules: createMockScheduleServer() })}
        >
          <ShellModeProvider agentConfig={{ mode: 'AgentLibraryWithComposer' }}>
            <SpaceProvider store={mockSpaceStore()}>
              <AgentConfigInstructionsProvider>
                <RuntimeHarness messages={[]}>
                  <div className="h-96">
                    <SidebarLayout />
                  </div>
                </RuntimeHarness>
              </AgentConfigInstructionsProvider>
            </SpaceProvider>
          </ShellModeProvider>
        </ServerProvider>
      </SlotsProvider>,
    );
    const nav = screen.getByRole('navigation', { name: 'Sidebar' });
    const highlighted = () =>
      Array.from(nav.querySelectorAll('[aria-current="page"]')).map(
        el => el.getAttribute('aria-label') ?? el.textContent?.trim(),
      );

    expect(highlighted()).toEqual(['Chats']);
    for (const entry of ['Spaces', 'Schedules']) {
      fireEvent.click(within(nav).getByRole('button', { name: entry }));
      await waitFor(() => expect(highlighted()).toEqual([entry]));
    }

    fireEvent.click(within(nav).getByRole('button', { name: 'More' }));
    fireEvent.click(within(screen.getByRole('menu')).getByRole('button', { name: 'Settings' }));
    await waitFor(() => expect(highlighted()).toEqual(['More']));

    fireEvent.click(within(nav).getByRole('button', { name: 'More' }));
    fireEvent.click(within(screen.getByRole('menu')).getByRole('button', { name: 'Agents' }));
    await waitFor(() => expect(highlighted()).toEqual(['More']));

    fireEvent.click(within(nav).getByRole('button', { name: 'Chats' }));
    await waitFor(() => expect(highlighted()).toEqual(['Chats']));
  });
});

describe('SidebarLayout More menu', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('moves every destination that is not a rail item into the More menu, and no rail item into it', () => {
    renderSidebarLayoutWithSpaces();

    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    const menu = screen.getByRole('menu');
    const names = within(menu)
      .getAllByRole('button')
      .map(button => button.getAttribute('aria-label') ?? button.textContent?.trim() ?? '');

    // Report a bug renders only when the bug-report feature is wired, as it does on main.
    expect(names).toEqual(expect.arrayContaining(['Start new agent', 'Settings']));
    expect(within(menu).getByRole('group', { name: 'Appearance' })).toBeInTheDocument();
    for (const railItem of ['Chats', 'New chat', 'Spaces']) {
      expect(names).not.toContain(railItem);
    }
  });

  it('has no Agents entry in the rail, and More, Agents opens the agents list right under Build agent', async () => {
    renderSidebarLayoutWithSpaces({ withLibrary: true });

    const nav = screen.getByRole('navigation', { name: 'Sidebar' });
    expect(within(nav).queryByRole('button', { name: 'Agents' })).toBeNull();

    fireEvent.click(within(nav).getByRole('button', { name: 'More' }));
    const menu = screen.getByRole('menu');
    const names = within(menu)
      .getAllByRole('button')
      .map(button => button.getAttribute('aria-label') ?? button.textContent?.trim() ?? '');
    expect(names.indexOf('Agents')).toBe(names.indexOf('Start new agent') + 1);

    fireEvent.click(within(menu).getByRole('button', { name: 'Agents' }));
    await screen.findByRole('heading', { name: 'Agents' });
  });

  it('shows Report a bug in the More menu as a row with its words, like the other rows', () => {
    renderSidebarLayoutWithSpaces({ withBugReport: true });

    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(within(screen.getByRole('menu')).getByRole('button', { name: 'Report a bug' })).toHaveTextContent(
      'Report a bug',
    );
  });

  it('opens the bug report dialog from the More menu row and keeps it open after the menu closes', async () => {
    renderSidebarLayoutWithSpaces({ withBugReport: true });

    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    fireEvent.click(within(screen.getByRole('menu')).getByRole('button', { name: 'Report a bug' }));

    const dialog = await screen.findByRole('dialog', { name: 'Report a bug' });
    expect(dialog).toHaveAttribute('open');
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    expect(screen.getByRole('dialog', { name: 'Report a bug' })).toHaveAttribute('open');
  });

  it('returns focus to the More button when the dialog closes', async () => {
    renderSidebarLayoutWithSpaces({ withBugReport: true });
    const more = screen.getByRole('button', { name: 'More' });

    fireEvent.click(more);
    fireEvent.click(within(screen.getByRole('menu')).getByRole('button', { name: 'Report a bug' }));
    const dialog = await screen.findByRole('dialog', { name: 'Report a bug' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));

    await waitFor(() => expect(more).toHaveFocus());
  });
});

// @vitest-environment jsdom
import { AgentConfigInstructionsProvider } from '@/atoms/draft/AgentConfigInstructionsContext.js';
import { SidebarLayout } from '@/layouts/SidebarLayout.js';
import { ServerProvider } from '@/server/ServerContext.js';
import { ShellModeProvider, useShellMode } from '@/server/ShellModeContext.js';
import { SpaceProvider, type SpaceStore } from '@/server/SpaceContext.js';
import { SlotsProvider } from '@/theme/SlotsProvider.js';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RuntimeHarness } from '../containers/RuntimeHarness.js';
import { createMockAgentUIServer, createMockCatalog } from '../server/mockServer.js';

const HISTORY_COLLAPSED_STORAGE_KEY = 'aui-history-collapsed';

function mockServer() {
  return createMockAgentUIServer({ catalog: createMockCatalog() });
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

describe('SidebarLayout recent-chats toggle', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('hides the recent-chats panel and flips aria-pressed / aria-label on toggle', async () => {
    renderSidebarLayout();

    expect(screen.getByRole('complementary', { name: 'Recent chats' })).toBeInTheDocument();

    const toggle = screen.getByRole('button', { name: 'Hide recent chats' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(toggle);

    await waitFor(() => {
      expect(screen.queryByRole('complementary', { name: 'Recent chats' })).not.toBeInTheDocument();
    });
    const shownToggle = screen.getByRole('button', { name: 'Show recent chats' });
    expect(shownToggle).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(shownToggle);

    await waitFor(() => {
      expect(screen.getByRole('complementary', { name: 'Recent chats' })).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Hide recent chats' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('persists the collapsed state across a remount via localStorage', async () => {
    const { unmount } = renderSidebarLayout();

    fireEvent.click(screen.getByRole('button', { name: 'Hide recent chats' }));
    await waitFor(() => {
      expect(localStorage.getItem(HISTORY_COLLAPSED_STORAGE_KEY)).toBe('true');
    });
    expect(screen.queryByRole('complementary', { name: 'Recent chats' })).not.toBeInTheDocument();

    unmount();
    renderSidebarLayout();

    expect(screen.queryByRole('complementary', { name: 'Recent chats' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show recent chats' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('does not show the toggle when the mode hides history anyway', async () => {
    renderSidebarLayoutInAgentBuilder();

    fireEvent.click(screen.getByRole('button', { name: 'Open agent builder' }));

    await waitFor(() => {
      expect(screen.queryByRole('complementary', { name: 'Recent chats' })).not.toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /^(Hide|Show) recent chats$/ })).not.toBeInTheDocument();
  });

  it('reveals the recent-chats panel inside the mobile drawer without closing it', async () => {
    renderSidebarLayout();

    // Collapse first so the drawer toggle reads "Show recent chats".
    fireEvent.click(screen.getByRole('button', { name: 'Hide recent chats' }));
    await waitFor(() => {
      expect(screen.queryByRole('complementary', { name: 'Recent chats' })).not.toBeInTheDocument();
    });

    // Open the mobile nav drawer.
    fireEvent.click(screen.getByRole('button', { name: 'Navigation' }));
    const dialog = await screen.findByRole('dialog', { name: 'Navigation' });

    // The drawer's toggle must not dismiss the drawer (the rail's onNavigate bubble
    // handler closes it on any other button click) and must reveal the panel.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Show recent chats' }));

    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: 'Navigation' })).toBeInTheDocument();
    });
    expect(
      within(screen.getByRole('dialog', { name: 'Navigation' })).getByRole('complementary', {
        name: 'Recent chats',
      }),
    ).toBeInTheDocument();

    // Toggling again hides the panel but keeps the drawer open.
    fireEvent.click(
      within(screen.getByRole('dialog', { name: 'Navigation' })).getByRole('button', {
        name: 'Hide recent chats',
      }),
    );
    await waitFor(() => {
      expect(
        within(screen.getByRole('dialog', { name: 'Navigation' })).queryByRole('complementary', {
          name: 'Recent chats',
        }),
      ).not.toBeInTheDocument();
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
  };
}

/** Same as `renderSidebarLayout`, plus a `SpaceProvider` so the Spaces nav button renders
 *  (it renders nothing without one — see `SpacesButton`). */
function renderSidebarLayoutWithSpaces() {
  return render(
    <SlotsProvider>
      <ServerProvider server={mockServer()}>
        <ShellModeProvider>
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
}

describe('SidebarLayout rail layout', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('lists the destinations in order: New chat, Chats, Spaces, Agents, then Build agent', () => {
    renderSidebarLayoutWithSpaces();

    const nav = screen.getByRole('navigation', { name: 'Sidebar' });
    const buttons = Array.from(nav.querySelectorAll('button'));
    const labelOf = (button: HTMLButtonElement) =>
      button.getAttribute('aria-label') ?? button.textContent?.trim() ?? '';
    // Schedules is off in this fixture; when it is on, it sits between Spaces and Agents.
    const order = ['Start new chat', 'Hide recent chats', 'Spaces', 'Agents', 'Start new agent'];
    const positions = order.map(label => buttons.findIndex(button => labelOf(button) === label));

    expect(positions.every(position => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    const newChat = buttons.find(button => labelOf(button) === 'Start new chat');
    const chats = buttons.find(button => labelOf(button) === 'Hide recent chats');
    expect(buttons[0]).toBe(newChat);
    expect(newChat?.textContent).toContain('New chat');
    expect(chats?.textContent).toContain('Chats');
  });

  it('renders every rail entry as a sibling of the next in one scrolling flex column, New Chat then toggle then Build Agent', () => {
    renderSidebarLayoutWithSpaces();

    const nav = screen.getByRole('navigation', { name: 'Sidebar' });
    expect(nav).toHaveClass('overflow-y-auto', 'min-h-0', 'flex-col');

    const newChat = screen.getByRole('button', { name: 'Start new chat' });
    const toggle = screen.getByRole('button', { name: 'Hide recent chats' });
    const buildAgent = screen.getByRole('button', { name: 'Start new agent' });

    // The entry for each (its own wrapper, if the atom renders one, or the button itself)
    // is a direct child of the same flex column, not split across a separately-boxed
    // `<nav>` and `<footer>` that could paint over each other.
    const entryIn = (nav: Element, el: Element): Element => {
      let current = el;
      while (current.parentElement !== nav) {
        const parent = current.parentElement;
        if (parent === null) throw new Error('Element is not inside the nav');
        current = parent;
      }
      return current;
    };
    const newChatEntry = entryIn(nav, newChat);
    const toggleEntry = entryIn(nav, toggle);
    const buildAgentEntry = entryIn(nav, buildAgent);
    expect(newChatEntry.parentElement).toBe(nav);
    expect(toggleEntry.parentElement).toBe(nav);
    expect(buildAgentEntry.parentElement).toBe(nav);

    // Document order: New Chat, toggle, Build Agent as plain siblings rather than elements
    // absolutely positioned over one another.
    expect(newChat.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(toggle.compareDocumentPosition(buildAgent) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    for (const el of [nav, newChat, toggle, buildAgent]) {
      expect(el).not.toHaveStyle({ position: 'absolute' });
    }
  });
});

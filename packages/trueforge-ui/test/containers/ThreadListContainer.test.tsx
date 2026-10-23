// @vitest-environment jsdom
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type ExternalStoreThreadListAdapter,
  type ThreadMessageLike,
} from '@assistant-ui/react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import type { ThreadListRowProps } from '@/atoms/ThreadListRow.js';
import { CompactLayoutProvider } from '@/atoms/lib/CompactLayoutContext.js';
import { ThreadListContainer, type ThreadListContainerProps } from '@/containers/ThreadListContainer.js';
import { ChatFolderProvider, type ChatFolderStore } from '@/server/ChatFolderContext.js';
import { ServerProvider } from '@/server/ServerContext.js';
import { ShellModeProvider, useShellMode } from '@/server/ShellModeContext.js';
import { SlotsProvider } from '@/theme/SlotsProvider.js';
import { createMockAgentUIServer } from '../server/mockServer.js';

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
});

function ThreadListRuntimeHarness({
  threadList,
  children,
}: {
  threadList: ExternalStoreThreadListAdapter;
  children: ReactNode;
}) {
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages: [],
    convertMessage: message => message,
    onNew: async () => {},
    adapters: { threadList },
  });

  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}

/**
 * Renders `ThreadListContainer` on a thread list adapter that actually applies `onRename` to
 * its own state, mirroring how the real `RemoteThreadListAdapter` optimistically updates
 * `threadData` regardless of what the host's `rename()` implementation does (it is a no-op in
 * `@truefoundry/assistant-ui-runtime` today). `renderThreadList`'s static adapter has no such
 * mechanism, so this harness is needed to test that a rename is reflected in the row.
 */
function RenamableThreadListHarness({
  onUpdateSession,
}: {
  onUpdateSession: (request: { sessionId: string; title?: string }) => void;
}) {
  const [title, setTitle] = useState('Remote session');
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages: [],
    convertMessage: message => message,
    onNew: async () => {},
    adapters: {
      threadList: {
        threadId: 'thread-1',
        threads: [{ status: 'regular', id: 'thread-1', remoteId: 'session-1', title }],
        onRename: async (_threadId, newTitle) => {
          setTitle(newTitle);
        },
      },
    },
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <SlotsProvider overrides={{ ThreadListRow: ThreadListRowOverride }}>
        <CompactLayoutProvider>
          <ServerProvider
            server={createMockAgentUIServer({
              updateSession: async ({ sessionId, title: nextTitle }) => {
                onUpdateSession({ sessionId, title: nextTitle });
                return {
                  id: sessionId,
                  title: nextTitle ?? null,
                  isMutable: true,
                  createdAt: new Date(0).toISOString(),
                  updatedAt: new Date(0).toISOString(),
                };
              },
            })}
          >
            <ThreadListContainer />
          </ServerProvider>
        </CompactLayoutProvider>
      </SlotsProvider>
    </AssistantRuntimeProvider>
  );
}

function ThreadListRowOverride({ title, active, onSelect, actions }: ThreadListRowProps) {
  return (
    <div data-testid={`thread-row-${title}`} data-active={active ? 'true' : 'false'}>
      <button type="button" onClick={onSelect}>
        {title}
      </button>
      {actions}
    </div>
  );
}

function TryAgentButton() {
  const shell = useShellMode();
  return (
    <>
      <button
        type="button"
        onClick={() =>
          shell.selectLibraryAgent({
            isMutable: false,
            agentId: 'support-id',
            agentName: 'Support Agent',
          })
        }
      >
        Try Support Agent
      </button>
      <button
        type="button"
        onClick={() =>
          shell.openHistorySession({
            sessionId: 'support-session',
            isMutable: false,
            agentName: 'Support Agent',
          })
        }
      >
        Open Support Session
      </button>
      <button
        type="button"
        onClick={() => {
          shell.setHistoryAgentFilter({
            agentId: 'support-id',
            agentName: 'Support Agent',
            intent: 'history',
          });
          shell.openHistorySession({
            sessionId: 'filtered-support-session',
            isMutable: false,
            agentName: 'Support Agent',
          });
        }}
      >
        Open Filtered Support Session
      </button>
    </>
  );
}

function renderThreadList({
  adapter,
  onThreadOpen,
  canDelete = false,
  canRename = false,
  onUpdateSession,
  variant,
  chatFolders,
}: {
  adapter: ExternalStoreThreadListAdapter;
  onThreadOpen?: () => void;
  canDelete?: boolean;
  canRename?: boolean;
  /** Spy invoked with the rename request when the mock `updateSession` is called. */
  onUpdateSession?: (request: { sessionId: string; title?: string }) => void;
  variant?: ThreadListContainerProps['variant'];
  chatFolders?: ChatFolderStore;
}) {
  const threadList = <ThreadListContainer onThreadOpen={onThreadOpen} variant={variant} />;
  const list = (
    <SlotsProvider overrides={{ ThreadListRow: ThreadListRowOverride }}>
      <ThreadListRuntimeHarness threadList={adapter}>
        <CompactLayoutProvider>
          {chatFolders !== undefined ? (
            <ChatFolderProvider store={chatFolders}>{threadList}</ChatFolderProvider>
          ) : (
            threadList
          )}
        </CompactLayoutProvider>
      </ThreadListRuntimeHarness>
    </SlotsProvider>
  );

  if (!canDelete && !canRename) {
    return render(list);
  }

  return render(
    <ServerProvider
      server={createMockAgentUIServer({
        ...(canDelete ? { deleteSession: async () => {} } : {}),
        ...(canRename
          ? {
              updateSession: async ({ sessionId, title }) => {
                onUpdateSession?.({ sessionId, title });
                return {
                  id: sessionId,
                  title: title ?? null,
                  isMutable: true,
                  createdAt: new Date(0).toISOString(),
                  updatedAt: new Date(0).toISOString(),
                };
              },
            }
          : {}),
      })}
    >
      {list}
    </ServerProvider>,
  );
}

describe('ThreadListContainer', () => {
  it('renders loading and empty list states from the runtime', () => {
    const { unmount } = renderThreadList({
      adapter: {
        isLoading: true,
        threads: [],
      },
    });

    expect(screen.getByRole('status', { name: 'Loading threads' })).toBeInTheDocument();
    unmount();

    renderThreadList({
      adapter: {
        isLoading: false,
        threads: [],
      },
    });

    expect(screen.getByText('No threads yet')).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'Loading threads' })).not.toBeInTheDocument();
  });

  it('starts a new chat and selects a row through the thread-list API', async () => {
    const onSwitchToNewThread = vi.fn(async () => {});
    const onSwitchToThread = vi.fn(async () => {});
    const onThreadOpen = vi.fn();

    renderThreadList({
      adapter: {
        threadId: 'thread-1',
        threads: [
          {
            status: 'regular',
            id: 'thread-1',
            title: 'Current session',
          },
          {
            status: 'regular',
            id: 'thread-2',
            title: 'Previous session',
          },
        ],
        onSwitchToNewThread,
        onSwitchToThread,
      },
      onThreadOpen,
    });

    expect(screen.getByTestId('thread-row-Current session')).toHaveAttribute('data-active', 'true');
    expect(screen.getByTestId('thread-row-Previous session')).toHaveAttribute('data-active', 'false');

    fireEvent.click(screen.getByRole('button', { name: 'Previous session' }));
    await waitFor(() => {
      expect(onSwitchToThread).toHaveBeenCalledWith('thread-2');
    });

    fireEvent.click(screen.getByRole('button', { name: 'Start new chat' }));
    await waitFor(() => {
      expect(onSwitchToNewThread).toHaveBeenCalledTimes(1);
    });
    expect(onThreadOpen).toHaveBeenCalledTimes(2);
  });

  it('shows persisted draft and named sessions in recent-history mode', () => {
    const { container } = renderThreadList({
      adapter: {
        threadId: 'draft-1',
        threads: [
          {
            status: 'regular',
            id: 'draft-1',
            remoteId: 'session-draft-1',
            title: 'Draft chat',
            custom: { isMutable: true },
          },
          {
            status: 'regular',
            id: 'named-1',
            remoteId: 'session-named-1',
            title: 'Named chat',
            custom: { isMutable: false },
          },
          {
            status: 'regular',
            id: 'local-draft',
            title: 'Unsaved chat',
            custom: { isMutable: true },
          },
        ],
      },
      variant: 'recent-history',
    });

    expect(screen.getByRole('button', { name: 'Draft chat' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Named chat' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Unsaved chat' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start new chat' })).not.toBeInTheDocument();
    expect(screen.queryByText('New Chat')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Chat History' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Chat History' })).not.toBeInTheDocument();
    expect(container.querySelector('[data-slot="aui_thread-list-viewport"]')).toHaveClass('aui-scrollbar-hidden');
  });

  it('uses filter intent to distinguish Try Agent from a filtered agent session', () => {
    const server = createMockAgentUIServer({
      searchAgents: async () => [{ name: 'Support Agent', agentId: 'support-id' }],
    });

    render(
      <ServerProvider server={server}>
        <ShellModeProvider agentConfig={{ mode: 'AgentLibraryWithComposer' }}>
          <SlotsProvider overrides={{ ThreadListRow: ThreadListRowOverride }}>
            <ThreadListRuntimeHarness threadList={{ threads: [] }}>
              <CompactLayoutProvider>
                <TryAgentButton />
                <ThreadListContainer variant="recent-history" />
              </CompactLayoutProvider>
            </ThreadListRuntimeHarness>
          </SlotsProvider>
        </ShellModeProvider>
      </ServerProvider>,
    );

    expect(screen.getByRole('button', { name: 'Filter chat history by agent' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try Support Agent' }));

    expect(screen.getByRole('heading', { name: 'Chats for Support Agent' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Filter chat history by agent/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Open Support Session' }));
    expect(screen.queryByRole('button', { name: /Filter chat history by agent/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Open Filtered Support Session' }));
    expect(screen.getByRole('button', { name: /Filter chat history by agent/ })).toBeInTheDocument();
  });

  it('shows the recent-history empty state when only an unsaved session exists', () => {
    renderThreadList({
      adapter: {
        threads: [
          {
            status: 'regular',
            id: 'local-draft',
            title: 'Unsaved chat',
            custom: { isMutable: true },
          },
        ],
      },
      variant: 'recent-history',
    });

    expect(screen.getByText('Your chats will show up here.')).toBeInTheDocument();
  });

  it('loads a named history session without leaving the recent list', async () => {
    function ActiveMode() {
      const shell = useShellMode();
      const name = shell.mode.status === 'active' ? shell.mode.agentName : undefined;
      return <output aria-label="Active agent">{name ?? 'draft'}</output>;
    }

    render(
      <SlotsProvider overrides={{ ThreadListRow: ThreadListRowOverride }}>
        <ServerProvider server={createMockAgentUIServer()}>
          <ShellModeProvider>
            <ThreadListRuntimeHarness
              threadList={{
                threads: [
                  {
                    status: 'regular',
                    id: 'named-1',
                    remoteId: 'session-named-1',
                    title: 'Named chat',
                    custom: { isMutable: false, agentName: 'named-agent' },
                  },
                ],
              }}
            >
              <CompactLayoutProvider>
                <ActiveMode />
                <ThreadListContainer variant="recent-history" />
              </CompactLayoutProvider>
            </ThreadListRuntimeHarness>
          </ShellModeProvider>
        </ServerProvider>
      </SlotsProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Named chat' }));

    await waitFor(() => expect(screen.getByRole('status', { name: 'Active agent' })).toHaveTextContent('named-agent'));
    expect(screen.getByRole('heading', { name: 'Chat History' })).toBeInTheDocument();
  });

  it('exposes delete only for remote sessions and delegates deletion to the runtime', async () => {
    const onDelete = vi.fn(async () => {});

    renderThreadList({
      adapter: {
        threadId: 'thread-1',
        threads: [
          {
            status: 'regular',
            id: 'thread-1',
            remoteId: 'session-1',
            title: 'Remote session',
          },
          {
            status: 'regular',
            id: 'thread-local',
            title: 'Local draft',
          },
        ],
        onDelete,
      },
      canDelete: true,
    });

    const actionButtons = screen.getAllByRole('button', { name: 'Session actions' });
    expect(actionButtons).toHaveLength(1);
    const actionButton = actionButtons[0];
    if (actionButton === undefined) {
      throw new Error('Expected session actions button');
    }
    fireEvent.click(actionButton);
    // "Show agent details" moved out of this menu to a header button next to Clear chat: it must
    // not appear here (desktop dropdown or mobile sheet) any more.
    expect(screen.queryByText('Show agent details')).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitemcheckbox')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    expect(onDelete).not.toHaveBeenCalled();

    const dialog = screen.getByRole('dialog', { name: 'Delete chat' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(onDelete).toHaveBeenCalledWith('thread-1');
    });
  });

  it('shows the "..." actions menu when only Rename is available', () => {
    renderThreadList({
      adapter: {
        threadId: 'thread-1',
        threads: [
          {
            status: 'regular',
            id: 'thread-1',
            remoteId: 'session-1',
            title: 'Remote session',
          },
        ],
      },
      // No delete permission and no chat-folders store, but a server (so Rename is available):
      // the "..." trigger must still render.
      canDelete: false,
      canRename: true,
    });

    const actionButton = screen.getByRole('button', { name: 'Session actions' });
    fireEvent.click(actionButton);
    expect(screen.getByRole('menuitem', { name: 'Rename' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Delete' })).not.toBeInTheDocument();
    expect(screen.queryByText('Move to folder')).not.toBeInTheDocument();
  });

  it('hides the "..." actions menu entirely when nothing is available', () => {
    renderThreadList({
      adapter: {
        threadId: 'thread-1',
        threads: [
          {
            status: 'regular',
            id: 'thread-1',
            remoteId: 'session-1',
            title: 'Remote session',
          },
        ],
      },
      // No delete permission, no chat-folders store, and no server (so Rename is unavailable
      // too): the "..." trigger itself must not render.
      canDelete: false,
      canRename: false,
    });

    expect(screen.queryByRole('button', { name: 'Session actions' })).not.toBeInTheDocument();
  });

  function openRenameDialog() {
    fireEvent.click(screen.getByRole('button', { name: 'Session actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    return screen.getByRole('textbox', { name: 'Chat title' });
  }

  it('renames a chat: saving persists the title and updates the sidebar row immediately', async () => {
    const onUpdateSession = vi.fn();
    render(<RenamableThreadListHarness onUpdateSession={onUpdateSession} />);

    const input = openRenameDialog();
    fireEvent.change(input, { target: { value: 'Renamed chat' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));

    await waitFor(() => {
      expect(onUpdateSession).toHaveBeenCalledWith({ sessionId: 'session-1', title: 'Renamed chat' });
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Renamed chat' })).toBeInTheDocument();
    });
    expect(screen.queryByRole('textbox', { name: 'Chat title' })).not.toBeInTheDocument();
  });

  it('renames a chat: Enter saves', async () => {
    const onUpdateSession = vi.fn();
    renderThreadList({
      adapter: {
        threadId: 'thread-1',
        threads: [
          {
            status: 'regular',
            id: 'thread-1',
            remoteId: 'session-1',
            title: 'Remote session',
          },
        ],
      },
      canRename: true,
      onUpdateSession,
    });

    const input = openRenameDialog();
    fireEvent.change(input, { target: { value: 'Renamed via Enter' } });
    const form = input.closest('form');
    if (form === null) {
      throw new Error('Expected the rename input to be inside a form');
    }
    fireEvent.submit(form);

    await waitFor(() => {
      expect(onUpdateSession).toHaveBeenCalledWith({ sessionId: 'session-1', title: 'Renamed via Enter' });
    });
  });

  it('renames a chat: Escape cancels without saving', () => {
    const onUpdateSession = vi.fn();
    renderThreadList({
      adapter: {
        threadId: 'thread-1',
        threads: [
          {
            status: 'regular',
            id: 'thread-1',
            remoteId: 'session-1',
            title: 'Remote session',
          },
        ],
      },
      canRename: true,
      onUpdateSession,
    });

    const input = openRenameDialog();
    fireEvent.change(input, { target: { value: 'Should not save' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(screen.queryByRole('textbox', { name: 'Chat title' })).not.toBeInTheDocument();
    expect(onUpdateSession).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Remote session' })).toBeInTheDocument();
  });

  it('renames a chat: empty input is rejected, not submitted', () => {
    const onUpdateSession = vi.fn();
    renderThreadList({
      adapter: {
        threadId: 'thread-1',
        threads: [
          {
            status: 'regular',
            id: 'thread-1',
            remoteId: 'session-1',
            title: 'Remote session',
          },
        ],
      },
      canRename: true,
      onUpdateSession,
    });

    const input = openRenameDialog();
    fireEvent.change(input, { target: { value: '   ' } });

    expect(screen.getByRole('button', { name: 'Rename' })).toBeDisabled();
    const form = input.closest('form');
    if (form === null) {
      throw new Error('Expected the rename input to be inside a form');
    }
    fireEvent.submit(form);

    expect(onUpdateSession).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: 'Chat title' })).toBeInTheDocument();
  });

  it('creates a new folder from the sidebar header and shows it in the list immediately', async () => {
    const createFolder = vi.fn(async ({ name }: { name: string }) => ({ id: 'folder-new', name }));
    renderThreadList({
      adapter: {
        threadId: 'thread-1',
        threads: [
          {
            status: 'regular',
            id: 'thread-1',
            remoteId: 'session-1',
            title: 'Remote session',
          },
        ],
      },
      chatFolders: {
        load: async () => ({ folders: [], assignments: [] }),
        createFolder,
        renameFolder: async ({ folderId, name }) => ({ id: folderId, name }),
        deleteFolder: async () => {},
        setSessionFolder: async () => {},
      },
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'New folder' })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: 'New folder' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'New folder name' }), {
      target: { value: 'Research' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(createFolder).toHaveBeenCalledWith({ name: 'Research' });
    });
    await waitFor(() => {
      expect(screen.getByRole('region', { name: 'Research' })).toBeInTheDocument();
    });
  });

  it('clears chat selection highlight while a sidebar top nav tab is open', () => {
    function OpenSchedulesButton() {
      const shell = useShellMode();
      return (
        <button type="button" onClick={() => shell.setSchedulesOpen(true)}>
          Open schedules tab
        </button>
      );
    }

    const server = createMockAgentUIServer({
      schedules: {
        listSchedules: vi.fn(async () => ({ data: [] })),
        getSchedule: vi.fn(),
        createSchedule: vi.fn(),
        updateSchedule: vi.fn(),
        deleteSchedule: vi.fn(),
        listScheduleRuns: vi.fn(async () => []),
        createScheduleRun: vi.fn(),
      },
    });

    render(
      <ServerProvider server={server}>
        <ShellModeProvider agentConfig={{ mode: 'AgentLibraryWithComposer' }}>
          <SlotsProvider overrides={{ ThreadListRow: ThreadListRowOverride }}>
            <ThreadListRuntimeHarness
              threadList={{
                threadId: 'thread-1',
                threads: [
                  {
                    status: 'regular',
                    id: 'thread-1',
                    title: 'Current session',
                  },
                ],
              }}
            >
              <CompactLayoutProvider>
                <OpenSchedulesButton />
                <ThreadListContainer />
              </CompactLayoutProvider>
            </ThreadListRuntimeHarness>
          </SlotsProvider>
        </ShellModeProvider>
      </ServerProvider>,
    );

    expect(screen.getByTestId('thread-row-Current session')).toHaveAttribute('data-active', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Open schedules tab' }));
    expect(screen.getByTestId('thread-row-Current session')).toHaveAttribute('data-active', 'false');
  });

  it('groups remote chats and moves an unfiled chat into a persisted folder', async () => {
    const setSessionFolder = vi.fn(async () => {});
    const chatFolders: ChatFolderStore = {
      load: async () => ({
        folders: [{ id: 'folder-work', name: 'Work' }],
        assignments: [{ sessionId: 'session-1', folderId: 'folder-work' }],
      }),
      createFolder: async ({ name }) => ({ id: 'folder-new', name }),
      renameFolder: async ({ folderId, name }) => ({ id: folderId, name }),
      deleteFolder: async () => {},
      setSessionFolder,
    };

    renderThreadList({
      adapter: {
        threadId: 'thread-1',
        threads: [
          { status: 'regular', id: 'thread-1', remoteId: 'session-1', title: 'Filed chat' },
          { status: 'regular', id: 'thread-2', remoteId: 'session-2', title: 'Unfiled chat' },
        ],
      },
      chatFolders,
    });

    expect(await screen.findByRole('region', { name: 'Work' })).toBeInTheDocument();
    const unfiledRow = screen.getByTestId('thread-row-Unfiled chat');
    const actionButton = unfiledRow.querySelector<HTMLButtonElement>('[aria-label="Session actions"]');
    if (actionButton === null) throw new Error('Expected session actions button');
    fireEvent.click(actionButton);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Move to folder' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Work' }));

    await waitFor(() => {
      expect(setSessionFolder).toHaveBeenCalledWith({ sessionId: 'session-2', folderId: 'folder-work' });
    });
  });
});

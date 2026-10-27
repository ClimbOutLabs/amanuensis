// @vitest-environment jsdom
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type ExternalStoreThreadListAdapter,
  type ThreadMessageLike,
} from '@assistant-ui/react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useEffect, useState, type ReactNode } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import type { ThreadListRowProps } from '@/atoms/ThreadListRow.js';
import { CompactLayoutProvider } from '@/atoms/lib/CompactLayoutContext.js';
import { ThreadListContainer, type ThreadListContainerProps } from '@/containers/ThreadListContainer.js';
import {
  CHAT_FOLDER_LOAD_TIMEOUT_MS,
  ChatFolderProvider,
  useOptionalChatFolders,
  type ChatFolderSnapshot,
  type ChatFolderStore,
} from '@/server/ChatFolderContext.js';
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

/** Counts every commit that reaches a folder consumer, so a test can prove rendering settles. */
function CommitProbe({ onCommit }: { onCommit: () => void }) {
  useOptionalChatFolders();
  useEffect(() => {
    onCommit();
  });
  return null;
}

/**
 * Renders the thread list on an adapter whose loaded chats can shrink, mirroring a chat
 * deleted or archived somewhere else, with folder state wrapped around the same list.
 */
function ShrinkingThreadListHarness({ chatFolders, onCommit }: { chatFolders: ChatFolderStore; onCommit: () => void }) {
  const [threads, setThreads] = useState<NonNullable<ExternalStoreThreadListAdapter['threads']>>([
    { status: 'regular', id: 'thread-1', remoteId: 'session-1', title: 'First chat' },
    { status: 'regular', id: 'thread-2', remoteId: 'session-2', title: 'Second chat' },
  ]);
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages: [],
    convertMessage: message => message,
    onNew: async () => {},
    adapters: { threadList: { threadId: 'thread-1', threads } },
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <SlotsProvider overrides={{ ThreadListRow: ThreadListRowOverride }}>
        <CompactLayoutProvider>
          <ChatFolderProvider store={chatFolders}>
            <button
              type="button"
              onClick={() => setThreads(current => current.filter(thread => thread.id !== 'thread-1'))}
            >
              Drop first chat
            </button>
            <CommitProbe onCommit={onCommit} />
            <ThreadListContainer />
          </ChatFolderProvider>
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
  it('sizes the search field and the Folders heading on the type scale, not a one-off literal', async () => {
    renderThreadList({
      adapter: { threads: [] },
      variant: 'recent-history',
      chatFolders: {
        load: async () => ({ folders: [], assignments: [], folderSessions: [], unfiledSessions: [] }),
        createFolder: async () => ({ id: 'f1', name: 'Research' }),
        renameFolder: async ({ folderId, name }) => ({ id: folderId, name }),
        deleteFolder: async () => {},
        setSessionFolder: async () => {},
      },
    });

    const heading = await screen.findByRole('heading', { name: 'Folders' });
    expect(heading).toHaveClass('text-xs');
    expect(heading.className).not.toMatch(/text-\[0\.75rem\]/);

    fireEvent.click(screen.getByRole('button', { name: 'Search chats' }));
    const searchField = screen.getByRole('searchbox', { name: 'Search chats' });
    expect(searchField).toHaveClass('text-sm');
    expect(searchField.className).not.toMatch(/text-\[0\.8125rem\]/);
  });

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
    expect(screen.getByRole('heading', { name: 'Chats' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Chats' })).not.toBeInTheDocument();
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
    expect(screen.getByRole('heading', { name: 'Chats' })).toBeInTheDocument();
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
    // The Agent details switch lives in the chat header: it must not appear in this menu
    // (desktop dropdown or mobile sheet).
    expect(screen.queryByText('Agent details')).not.toBeInTheDocument();
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
        load: async () => ({ folders: [], assignments: [], folderSessions: [], unfiledSessions: [] }),
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
        folderSessions: [
          {
            folderId: 'folder-work',
            sessions: [
              {
                sessionId: 'session-1',
                title: 'Filed chat',
                updatedAt: new Date('2026-10-20T12:00:00.000Z'),
                agentName: null,
                isMutable: true,
              },
            ],
          },
        ],
        unfiledSessions: [],
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
    await waitFor(() => {
      expect(within(screen.getByRole('region', { name: 'Work' })).getByTestId('thread-row-Unfiled chat')).toBeVisible();
    });
  });

  it('shows every chat in a folder even when the recent list only has the first page', async () => {
    const folderSessions = Array.from({ length: 35 }, (_, index) => {
      const number = index + 1;
      return {
        sessionId: `folder-session-${number}`,
        title: `Folder chat ${number}`,
        updatedAt: new Date(Date.UTC(2026, 9, 20, 12, 0, 0) - number * 60_000),
        agentName: null,
        isMutable: true,
      };
    });
    const chatFolders: ChatFolderStore = {
      load: async () => ({
        folders: [{ id: 'folder-archive', name: 'Archive' }],
        assignments: folderSessions.map(session => ({ sessionId: session.sessionId, folderId: 'folder-archive' })),
        folderSessions: [{ folderId: 'folder-archive', sessions: folderSessions }],
        unfiledSessions: [],
      }),
      createFolder: async ({ name }) => ({ id: 'folder-new', name }),
      renameFolder: async ({ folderId, name }) => ({ id: folderId, name }),
      deleteFolder: async () => {},
      setSessionFolder: async () => {},
    };

    renderThreadList({
      adapter: {
        threadId: 'thread-1',
        threads: Array.from({ length: 25 }, (_, index) => {
          const number = index + 1;
          return {
            status: 'regular',
            id: `thread-${number}`,
            remoteId: `recent-session-${number}`,
            title: `Recent chat ${number}`,
          };
        }),
      },
      chatFolders,
    });

    const archive = await screen.findByRole('region', { name: 'Archive' });
    expect(within(archive).getByTestId('thread-row-Folder chat 35')).toBeInTheDocument();
    expect(archive.querySelectorAll('[data-testid^="thread-row-Folder chat"]')).toHaveLength(35);
    expect(within(archive).getByText('35')).toBeInTheDocument();
  });

  describe('deleting a chat loaded only by its folder', () => {
    const folderChat = {
      sessionId: 'folder-only-session',
      title: 'Lease notes',
      updatedAt: new Date(Date.UTC(2026, 9, 20, 12, 0, 0)),
      agentName: null,
      isMutable: true,
    };
    const chatFolders: ChatFolderStore = {
      load: async () => ({
        folders: [{ id: 'folder-home', name: 'Home' }],
        assignments: [{ sessionId: folderChat.sessionId, folderId: 'folder-home' }],
        folderSessions: [{ folderId: 'folder-home', sessions: [folderChat] }],
        unfiledSessions: [],
      }),
      createFolder: async ({ name }) => ({ id: 'folder-new', name }),
      renameFolder: async ({ folderId, name }) => ({ id: folderId, name }),
      deleteFolder: async () => {},
      setSessionFolder: async () => {},
    };

    async function openFolderChatDelete(deleteSession: (request: { sessionId: string }) => Promise<void>) {
      render(
        <ServerProvider server={createMockAgentUIServer({ deleteSession })}>
          <SlotsProvider overrides={{ ThreadListRow: ThreadListRowOverride }}>
            <ThreadListRuntimeHarness threadList={{ threadId: 'thread-1', threads: [] }}>
              <CompactLayoutProvider>
                <ChatFolderProvider store={chatFolders}>
                  <ThreadListContainer />
                </ChatFolderProvider>
              </CompactLayoutProvider>
            </ThreadListRuntimeHarness>
          </SlotsProvider>
        </ServerProvider>,
      );
      const row = await screen.findByTestId('thread-row-Lease notes');
      fireEvent.click(within(row).getByRole('button', { name: 'Session actions' }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
      return screen.getByRole('dialog', { name: 'Delete chat' });
    }

    it('asks first, then deletes it through the server once and removes the row', async () => {
      const deleteSession = vi.fn(async (_request: { sessionId: string }) => {});
      const dialog = await openFolderChatDelete(deleteSession);
      expect(deleteSession).not.toHaveBeenCalled();

      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

      await waitFor(() => {
        expect(screen.queryByTestId('thread-row-Lease notes')).not.toBeInTheDocument();
      });
      expect(deleteSession).toHaveBeenCalledTimes(1);
      expect(deleteSession).toHaveBeenCalledWith({ sessionId: 'folder-only-session' });
    });

    it('says so in the dialog and keeps the row when the delete fails', async () => {
      const deleteSession = vi.fn(async (_request: { sessionId: string }) => {
        throw new Error('offline');
      });
      const dialog = await openFolderChatDelete(deleteSession);

      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

      expect(await within(dialog).findByText('Could not delete this chat. Try again.')).toBeInTheDocument();
      expect(screen.getByTestId('thread-row-Lease notes')).toBeInTheDocument();
    });
  });

  it('moves a chat loaded by folder into another folder without a reload', async () => {
    const setSessionFolder = vi.fn(async () => {});
    const session = {
      sessionId: 'session-filed',
      title: 'Filed only chat',
      updatedAt: new Date('2026-10-20T12:00:00.000Z'),
      agentName: null,
      isMutable: true,
    };
    const chatFolders: ChatFolderStore = {
      load: async () => ({
        folders: [
          { id: 'folder-a', name: 'Folder A' },
          { id: 'folder-b', name: 'Folder B' },
        ],
        assignments: [{ sessionId: session.sessionId, folderId: 'folder-a' }],
        folderSessions: [
          { folderId: 'folder-a', sessions: [session] },
          { folderId: 'folder-b', sessions: [] },
        ],
        unfiledSessions: [],
      }),
      createFolder: async ({ name }) => ({ id: 'folder-new', name }),
      renameFolder: async ({ folderId, name }) => ({ id: folderId, name }),
      deleteFolder: async () => {},
      setSessionFolder,
    };

    renderThreadList({
      adapter: {
        threadId: 'thread-1',
        threads: [{ status: 'regular', id: 'thread-1', remoteId: 'session-current', title: 'Current chat' }],
      },
      chatFolders,
    });

    const filedRow = await screen.findByTestId('thread-row-Filed only chat');
    const actionButton = filedRow.querySelector<HTMLButtonElement>('[aria-label="Session actions"]');
    if (actionButton === null) throw new Error('Expected session actions button');
    fireEvent.click(actionButton);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Move to folder' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Folder B' }));

    await waitFor(() => {
      expect(setSessionFolder).toHaveBeenCalledWith({ sessionId: 'session-filed', folderId: 'folder-b' });
    });
    await waitFor(() => {
      expect(
        within(screen.getByRole('region', { name: 'Folder B' })).getByTestId('thread-row-Filed only chat'),
      ).toBeVisible();
    });
    expect(
      within(screen.getByRole('region', { name: 'Folder A' })).queryByTestId('thread-row-Filed only chat'),
    ).not.toBeInTheDocument();
  });

  it('moves a chat loaded by folder to No folder and keeps it under Unfiled', async () => {
    const setSessionFolder = vi.fn(async () => {});
    const onThreadOpen = vi.fn();
    const filedSession = {
      sessionId: 'session-filed',
      title: 'Filed only chat',
      updatedAt: new Date('2026-10-20T12:00:00.000Z'),
      agentName: null,
      isMutable: true,
    };
    const otherSession = {
      sessionId: 'session-other',
      title: 'Other folder chat',
      updatedAt: new Date('2026-10-19T12:00:00.000Z'),
      agentName: null,
      isMutable: true,
    };
    const chatFolders: ChatFolderStore = {
      load: async () => ({
        folders: [
          { id: 'folder-a', name: 'Folder A' },
          { id: 'folder-b', name: 'Folder B' },
        ],
        assignments: [
          { sessionId: filedSession.sessionId, folderId: 'folder-a' },
          { sessionId: otherSession.sessionId, folderId: 'folder-b' },
        ],
        folderSessions: [
          { folderId: 'folder-a', sessions: [filedSession] },
          { folderId: 'folder-b', sessions: [otherSession] },
        ],
        unfiledSessions: [],
      }),
      createFolder: async ({ name }) => ({ id: 'folder-new', name }),
      renameFolder: async ({ folderId, name }) => ({ id: folderId, name }),
      deleteFolder: async () => {},
      setSessionFolder,
    };

    renderThreadList({
      adapter: {
        threadId: 'thread-1',
        threads: [{ status: 'regular', id: 'thread-1', remoteId: 'session-current', title: 'Current chat' }],
      },
      chatFolders,
      onThreadOpen,
    });

    const filedRow = await screen.findByTestId('thread-row-Filed only chat');
    const actionButton = filedRow.querySelector<HTMLButtonElement>('[aria-label="Session actions"]');
    if (actionButton === null) throw new Error('Expected session actions button');
    fireEvent.click(actionButton);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Move to folder' }));
    fireEvent.click(await screen.findByRole('button', { name: 'No folder' }));

    await waitFor(() => {
      expect(setSessionFolder).toHaveBeenCalledWith({ sessionId: 'session-filed', folderId: null });
    });
    const unfiled = await screen.findByRole('region', { name: 'Unfiled chats' });
    await waitFor(() => {
      expect(within(unfiled).getByTestId('thread-row-Filed only chat')).toBeVisible();
    });
    expect(
      within(screen.getByRole('region', { name: 'Folder A' })).queryByTestId('thread-row-Filed only chat'),
    ).not.toBeInTheDocument();

    const movedRow = within(unfiled).getByTestId('thread-row-Filed only chat');
    const openButton = movedRow.querySelector<HTMLButtonElement>('button');
    if (openButton === null) throw new Error('Expected row button');
    fireEvent.click(openButton);
    expect(onThreadOpen).toHaveBeenCalled();
  });

  it('deleting a folder whose chats are not in the recent list lands them under Unfiled', async () => {
    const deleteFolder = vi.fn(async () => {});
    const first = {
      sessionId: 'session-one',
      title: 'Folder chat one',
      updatedAt: new Date('2026-10-20T12:00:00.000Z'),
      agentName: null,
      isMutable: true,
    };
    const second = {
      sessionId: 'session-two',
      title: 'Folder chat two',
      updatedAt: new Date('2026-10-19T12:00:00.000Z'),
      agentName: null,
      isMutable: true,
    };
    const chatFolders: ChatFolderStore = {
      load: async () => ({
        folders: [{ id: 'folder-a', name: 'Folder A' }],
        assignments: [
          { sessionId: first.sessionId, folderId: 'folder-a' },
          { sessionId: second.sessionId, folderId: 'folder-a' },
        ],
        folderSessions: [{ folderId: 'folder-a', sessions: [first, second] }],
        unfiledSessions: [],
      }),
      createFolder: async ({ name }) => ({ id: 'folder-new', name }),
      renameFolder: async ({ folderId, name }) => ({ id: folderId, name }),
      deleteFolder,
      setSessionFolder: async () => {},
    };

    renderThreadList({
      adapter: {
        threadId: 'thread-1',
        threads: [{ status: 'regular', id: 'thread-1', remoteId: 'session-current', title: 'Current chat' }],
      },
      chatFolders,
    });

    expect(await screen.findByRole('region', { name: 'Folder A' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Manage Folder A' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete folder' }));

    await waitFor(() => {
      expect(deleteFolder).toHaveBeenCalledWith({ folderId: 'folder-a' });
    });
    expect(screen.queryByRole('region', { name: 'Folder A' })).not.toBeInTheDocument();
    const unfiled = await screen.findByRole('region', { name: 'Unfiled chats' });
    expect(within(unfiled).getByTestId('thread-row-Folder chat one')).toBeInTheDocument();
    expect(within(unfiled).getByTestId('thread-row-Folder chat two')).toBeInTheDocument();
  });

  it('shows chats with no folder loaded from the server under Unfiled', async () => {
    const looseSession = {
      sessionId: 'session-loose',
      title: 'Loose chat',
      updatedAt: new Date('2026-10-20T12:00:00.000Z'),
      agentName: null,
      isMutable: true,
    };
    const chatFolders: ChatFolderStore = {
      load: async () => ({
        folders: [{ id: 'folder-a', name: 'Folder A' }],
        assignments: [],
        folderSessions: [{ folderId: 'folder-a', sessions: [] }],
        unfiledSessions: [looseSession],
      }),
      createFolder: async ({ name }) => ({ id: 'folder-new', name }),
      renameFolder: async ({ folderId, name }) => ({ id: folderId, name }),
      deleteFolder: async () => {},
      setSessionFolder: async () => {},
    };

    renderThreadList({
      adapter: {
        threadId: 'thread-1',
        threads: [{ status: 'regular', id: 'thread-1', remoteId: 'session-current', title: 'Current chat' }],
      },
      chatFolders,
    });

    const unfiled = await screen.findByRole('region', { name: 'Unfiled chats' });
    expect(within(unfiled).getByTestId('thread-row-Loose chat')).toBeInTheDocument();
    expect(
      within(screen.getByRole('region', { name: 'Folder A' })).queryByTestId('thread-row-Loose chat'),
    ).not.toBeInTheDocument();
  });

  it('keeps recent chats visible and gives the next step when folder chats cannot load', async () => {
    const chatFolders: ChatFolderStore = {
      load: async () => {
        throw new Error('Folder service unavailable');
      },
      createFolder: async ({ name }) => ({ id: 'folder-new', name }),
      renameFolder: async ({ folderId, name }) => ({ id: folderId, name }),
      deleteFolder: async () => {},
      setSessionFolder: async () => {},
    };

    renderThreadList({
      adapter: {
        threadId: 'thread-1',
        threads: [{ status: 'regular', id: 'thread-1', remoteId: 'session-1', title: 'Recent chat' }],
      },
      chatFolders,
    });

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not load folder chats. Refresh the page to try again.',
    );
    expect(screen.getByTestId('thread-row-Recent chat')).toBeInTheDocument();
  });

  it('shows the plain error and keeps recent chats when a folder load never finishes', async () => {
    vi.useFakeTimers();
    try {
      const chatFolders: ChatFolderStore = {
        load: () => new Promise<ChatFolderSnapshot>(() => {}),
        createFolder: async ({ name }) => ({ id: 'folder-new', name }),
        renameFolder: async ({ folderId, name }) => ({ id: folderId, name }),
        deleteFolder: async () => {},
        setSessionFolder: async () => {},
      };

      renderThreadList({
        adapter: {
          threadId: 'thread-1',
          threads: [{ status: 'regular', id: 'thread-1', remoteId: 'session-1', title: 'Recent chat' }],
        },
        chatFolders,
      });

      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(CHAT_FOLDER_LOAD_TIMEOUT_MS);
      });

      expect(screen.getByRole('alert')).toHaveTextContent(
        'Could not load folder chats. Refresh the page to try again.',
      );
      expect(screen.getByTestId('thread-row-Recent chat')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('applies a folder load that finishes after the error and clears the error', async () => {
    vi.useFakeTimers();
    try {
      let resolveLoad: (snapshot: ChatFolderSnapshot) => void = () => {};
      const chatFolders: ChatFolderStore = {
        load: () =>
          new Promise<ChatFolderSnapshot>(resolve => {
            resolveLoad = resolve;
          }),
        createFolder: async ({ name }) => ({ id: 'folder-new', name }),
        renameFolder: async ({ folderId, name }) => ({ id: folderId, name }),
        deleteFolder: async () => {},
        setSessionFolder: async () => {},
      };

      renderThreadList({
        adapter: {
          threadId: 'thread-1',
          threads: [{ status: 'regular', id: 'thread-1', remoteId: 'session-1', title: 'Recent chat' }],
        },
        chatFolders,
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(CHAT_FOLDER_LOAD_TIMEOUT_MS);
      });
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Could not load folder chats. Refresh the page to try again.',
      );

      await act(async () => {
        resolveLoad({
          folders: [{ id: 'folder-a', name: 'Folder A' }],
          assignments: [{ sessionId: 'session-filed', folderId: 'folder-a' }],
          folderSessions: [
            {
              folderId: 'folder-a',
              sessions: [
                {
                  sessionId: 'session-filed',
                  title: 'Filed chat',
                  updatedAt: new Date('2026-10-20T12:00:00.000Z'),
                  agentName: null,
                  isMutable: true,
                },
              ],
            },
          ],
          unfiledSessions: [],
        });
      });

      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      const folder = screen.getByRole('region', { name: 'Folder A' });
      expect(within(folder).getByTestId('thread-row-Filed chat')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles after a dropped loaded chat has its folder copy removed', async () => {
    const chatFolders: ChatFolderStore = {
      load: async () => ({
        folders: [{ id: 'folder-a', name: 'Folder A' }],
        assignments: [
          { sessionId: 'session-1', folderId: 'folder-a' },
          { sessionId: 'session-outside', folderId: 'folder-a' },
        ],
        folderSessions: [
          {
            folderId: 'folder-a',
            sessions: [
              {
                sessionId: 'session-1',
                title: 'First chat',
                updatedAt: new Date('2026-10-20T12:00:00.000Z'),
                agentName: null,
                isMutable: true,
              },
              {
                sessionId: 'session-outside',
                title: 'Outside chat',
                updatedAt: new Date('2026-10-19T12:00:00.000Z'),
                agentName: null,
                isMutable: true,
              },
            ],
          },
        ],
        unfiledSessions: [],
      }),
      createFolder: async ({ name }) => ({ id: 'folder-new', name }),
      renameFolder: async ({ folderId, name }) => ({ id: folderId, name }),
      deleteFolder: async () => {},
      setSessionFolder: async () => {},
    };

    let commits = 0;
    render(
      <ShrinkingThreadListHarness
        chatFolders={chatFolders}
        onCommit={() => {
          commits++;
        }}
      />,
    );

    const folder = await screen.findByRole('region', { name: 'Folder A' });
    expect(within(folder).getByTestId('thread-row-Outside chat')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Drop first chat' }));

    await waitFor(() => {
      expect(screen.queryByTestId('thread-row-First chat')).not.toBeInTheDocument();
    });
    expect(within(folder).getByTestId('thread-row-Outside chat')).toBeInTheDocument();

    const settledCommits = commits;
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(commits).toBe(settledCommits);
    expect(commits).toBeLessThan(50);
  });
});

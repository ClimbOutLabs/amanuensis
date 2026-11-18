// @vitest-environment jsdom
import { AssistantRuntimeProvider, useExternalStoreRuntime, type ThreadMessageLike } from '@assistant-ui/react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ThreadListRowProps } from '@/atoms/ThreadListRow.js';
import { CompactLayoutProvider } from '@/atoms/lib/CompactLayoutContext.js';
import { ThreadListContainer } from '@/containers/ThreadListContainer.js';
import { ChatFolderProvider, type ChatFolderStore } from '@/server/ChatFolderContext.js';
import { ServerProvider } from '@/server/ServerContext.js';
import { SlotsProvider } from '@/theme/SlotsProvider.js';
import { createMockAgentUIServer } from '../server/mockServer.js';

function ThreadListRowOverride({ title, onSelect, actions }: ThreadListRowProps) {
  return (
    <div data-testid={`thread-row-${title}`}>
      <button type="button" onClick={onSelect}>
        {title}
      </button>
      {actions}
    </div>
  );
}

/**
 * One remote chat in the sidebar. Its runtime `delete` goes through `deleteSession`, as the
 * production thread-list adapter does, so a confirmed delete reaches the server exactly once.
 */
function DeleteChatHarness({
  title,
  deleteSession,
  archiveStore,
}: {
  title: string;
  archiveStore?: ChatFolderStore;
  deleteSession: (request: { sessionId: string }) => Promise<void>;
}) {
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages: [],
    convertMessage: message => message,
    onNew: async () => {},
    adapters: {
      threadList: {
        threadId: 'thread-1',
        threads: [{ status: 'regular', id: 'thread-1', remoteId: 'session-1', title }],
        onDelete: async () => {
          await deleteSession({ sessionId: 'session-1' });
        },
      },
    },
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <SlotsProvider overrides={{ ThreadListRow: ThreadListRowOverride }}>
        <CompactLayoutProvider>
          <ServerProvider server={createMockAgentUIServer({ deleteSession })}>
            <ChatFolderProvider store={archiveStore}>
              <ThreadListContainer variant="recent-history" />
            </ChatFolderProvider>
          </ServerProvider>
        </CompactLayoutProvider>
      </SlotsProvider>
    </AssistantRuntimeProvider>
  );
}

function openDeleteDialog() {
  fireEvent.click(screen.getByRole('button', { name: 'Session actions' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
  return screen.getByRole('dialog', { name: 'Delete chat' });
}

describe('ChatFolderControls delete confirmation', () => {
  it('opens the confirm dialog from Delete without calling the server', () => {
    const deleteSession = vi.fn(async (_request: { sessionId: string }) => {});
    render(<DeleteChatHarness title="Quarterly plan" deleteSession={deleteSession} />);

    const dialog = openDeleteDialog();

    expect(within(dialog).getByRole('heading', { name: 'Delete this chat?' })).toBeInTheDocument();
    expect(within(dialog).getByText('Quarterly plan will be gone for good.')).toBeInTheDocument();
    expect(deleteSession).not.toHaveBeenCalled();
  });

  it('closes the dialog with Keep and never calls the server', async () => {
    const deleteSession = vi.fn(async (_request: { sessionId: string }) => {});
    render(<DeleteChatHarness title="Quarterly plan" deleteSession={deleteSession} />);

    const dialog = openDeleteDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Delete chat' })).not.toBeInTheDocument();
    });
    expect(deleteSession).not.toHaveBeenCalled();
  });

  it('deletes the chat through the server once after Delete is confirmed', async () => {
    const deleteSession = vi.fn(async (_request: { sessionId: string }) => {});
    render(<DeleteChatHarness title="Quarterly plan" deleteSession={deleteSession} />);

    const dialog = openDeleteDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(deleteSession).toHaveBeenCalledTimes(1);
    });
    expect(deleteSession).toHaveBeenCalledWith({ sessionId: 'session-1' });
  });
});

describe('chat archive', () => {
  function archiveStore(setSessionArchived: NonNullable<ChatFolderStore['setSessionArchived']>): ChatFolderStore {
    return {
      load: async () => ({ folders: [], assignments: [], folderSessions: [], unfiledSessions: [] }),
      createFolder: vi.fn(),
      renameFolder: vi.fn(),
      deleteFolder: vi.fn(),
      setSessionFolder: vi.fn(),
      setSessionArchived,
    };
  }

  it('archives, finds the chat in search and restores it from the archive', async () => {
    const setSessionArchived = vi.fn(async () => {});
    render(
      <DeleteChatHarness
        title="Quarterly plan"
        deleteSession={vi.fn()}
        archiveStore={archiveStore(setSessionArchived)}
      />,
    );
    await waitFor(() => expect(screen.getByRole('button', { name: 'Archived chats' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Session actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Archive chat' }));
    await waitFor(() => expect(screen.queryByTestId('thread-row-Quarterly plan')).toBeNull());
    expect(setSessionArchived).toHaveBeenCalledWith({ sessionId: 'session-1', archived: true });

    fireEvent.click(screen.getByRole('button', { name: 'Search chats' }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search chats' }), { target: { value: 'Quarterly' } });
    expect(screen.getByTestId('thread-row-Quarterly plan')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Search chats' }));

    fireEvent.click(screen.getByRole('button', { name: 'Archived chats' }));
    expect(screen.getByTestId('thread-row-Quarterly plan')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Session actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Restore chat' }));
    await waitFor(() => expect(screen.queryByTestId('thread-row-Quarterly plan')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Back to chats' }));
    expect(screen.getByTestId('thread-row-Quarterly plan')).toBeInTheDocument();
    expect(setSessionArchived).toHaveBeenLastCalledWith({ sessionId: 'session-1', archived: false });
  });

  it('keeps a chat visible if the archive write fails', async () => {
    render(
      <DeleteChatHarness
        title="Quarterly plan"
        deleteSession={vi.fn()}
        archiveStore={archiveStore(async () => {
          throw new Error('offline');
        })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Session actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Archive chat' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Could not change the archive. Try again.'),
    );
    expect(screen.getByTestId('thread-row-Quarterly plan')).toBeInTheDocument();
  });
});

// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  ChatFolderProvider,
  useOptionalChatFolders,
  type ChatFolderSnapshot,
  type ChatFolderStore,
} from '@/server/ChatFolderContext.js';

function snapshotWith(unfiledIds: string[]): ChatFolderSnapshot {
  return {
    folders: [],
    assignments: [],
    folderSessions: [],
    unfiledSessions: unfiledIds.map(sessionId => ({
      sessionId,
      title: sessionId,
      updatedAt: new Date('2026-11-18T00:00:00.000Z'),
      agentName: null,
      isMutable: true,
    })),
  };
}

function storeReturning(load: ChatFolderStore['load']): ChatFolderStore {
  return {
    load,
    createFolder: async ({ name }) => ({ id: 'folder-1', name }),
    renameFolder: async ({ folderId, name }) => ({ id: folderId, name }),
    deleteFolder: async () => {},
    setSessionFolder: async () => {},
  };
}

type FolderContextValue = ReturnType<typeof useOptionalChatFolders>;

function Probe({ capture }: { capture: (value: FolderContextValue) => void }) {
  const value = useOptionalChatFolders();
  capture(value);
  return (
    <>
      <div data-testid="unfiled">{(value?.unfiledSessions ?? []).map(session => session.sessionId).join(',')}</div>
      <div data-testid="folders">{(value?.folders ?? []).map(folder => folder.name).join(',')}</div>
      <div data-testid="titles">{(value?.unfiledSessions ?? []).map(session => session.title).join(',')}</div>
    </>
  );
}

function snapshotWithFolders(folders: Array<{ id: string; name: string }>): ChatFolderSnapshot {
  return { folders, assignments: [], folderSessions: [], unfiledSessions: [] };
}

/** A store whose first load resolves with the initial snapshot and whose later loads stay open until released. */
function deferredLaterLoads(initial: ChatFolderSnapshot) {
  let resolveLoad: (snapshot: ChatFolderSnapshot) => void = () => undefined;
  let loads = 0;
  const store = storeReturning(() => {
    loads++;
    if (loads === 1) return Promise.resolve(initial);
    return new Promise<ChatFolderSnapshot>(resolve => {
      resolveLoad = resolve;
    });
  });
  return {
    store,
    releaseLoad: (snapshot: ChatFolderSnapshot) => {
      resolveLoad(snapshot);
    },
  };
}

describe('ChatFolderProvider reload', () => {
  it('shows a chat that appears in a later load', async () => {
    let current = snapshotWith(['session-1']);
    const store = storeReturning(async () => current);
    let captured: FolderContextValue = null;
    render(
      <ChatFolderProvider store={store}>
        <Probe
          capture={value => {
            captured = value;
          }}
        />
      </ChatFolderProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('unfiled')).toHaveTextContent('session-1');
    });

    current = snapshotWith(['session-1', 'session-2']);
    act(() => {
      captured?.reload();
    });

    await waitFor(() => {
      expect(screen.getByTestId('unfiled')).toHaveTextContent('session-1,session-2');
    });
  });

  it('keeps a removed chat out when a load started before the removal lands after it', async () => {
    let resolveLoad: (snapshot: ChatFolderSnapshot) => void = () => undefined;
    let loads = 0;
    const store = storeReturning(() => {
      loads++;
      if (loads === 1) return Promise.resolve(snapshotWith(['session-1']));
      return new Promise<ChatFolderSnapshot>(resolve => {
        resolveLoad = resolve;
      });
    });
    let captured: FolderContextValue = null;
    render(
      <ChatFolderProvider store={store}>
        <Probe
          capture={value => {
            captured = value;
          }}
        />
      </ChatFolderProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('unfiled')).toHaveTextContent('session-1');
    });

    act(() => {
      captured?.reload();
      captured?.removeFolderSession({ sessionId: 'session-1' });
    });
    expect(screen.getByTestId('unfiled')).toHaveTextContent('');

    await act(async () => {
      resolveLoad(snapshotWith(['session-1']));
    });

    expect(screen.getByTestId('unfiled')).toHaveTextContent('');
  });
});

describe('ChatFolderProvider local edits', () => {
  it('keeps a renamed folder name when a load started before the rename lands after it', async () => {
    const before = snapshotWithFolders([{ id: 'folder-1', name: 'Old name' }]);
    const { store, releaseLoad } = deferredLaterLoads(before);
    let captured: FolderContextValue = null;
    render(
      <ChatFolderProvider store={store}>
        <Probe
          capture={value => {
            captured = value;
          }}
        />
      </ChatFolderProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('folders')).toHaveTextContent('Old name');
    });

    act(() => {
      captured?.reload();
    });
    await act(async () => {
      await captured?.renameFolder({ folderId: 'folder-1', name: 'New name' });
    });
    expect(screen.getByTestId('folders')).toHaveTextContent('New name');

    await act(async () => {
      releaseLoad(before);
    });

    expect(screen.getByTestId('folders')).toHaveTextContent('New name');
  });

  it('keeps a created folder when a load started before the create lands after it', async () => {
    const before = snapshotWithFolders([{ id: 'folder-1', name: 'Existing' }]);
    const { store, releaseLoad } = deferredLaterLoads(before);
    let captured: FolderContextValue = null;
    render(
      <ChatFolderProvider store={store}>
        <Probe
          capture={value => {
            captured = value;
          }}
        />
      </ChatFolderProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('folders')).toHaveTextContent('Existing');
    });

    act(() => {
      captured?.reload();
    });
    await act(async () => {
      await captured?.createFolder({ name: 'Brand new' });
    });
    expect(screen.getByTestId('folders').textContent).toBe('Brand new,Existing');

    await act(async () => {
      releaseLoad(before);
    });

    expect(screen.getByTestId('folders').textContent).toBe('Brand new,Existing');
  });

  it('keeps a deleted folder gone when a load started before the delete lands after it', async () => {
    const before = snapshotWithFolders([{ id: 'folder-1', name: 'Doomed' }]);
    const { store, releaseLoad } = deferredLaterLoads(before);
    let captured: FolderContextValue = null;
    render(
      <ChatFolderProvider store={store}>
        <Probe
          capture={value => {
            captured = value;
          }}
        />
      </ChatFolderProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('folders')).toHaveTextContent('Doomed');
    });

    act(() => {
      captured?.reload();
    });
    await act(async () => {
      await captured?.deleteFolder({ folderId: 'folder-1' });
    });
    expect(screen.getByTestId('folders').textContent).toBe('');

    await act(async () => {
      releaseLoad(before);
    });

    expect(screen.getByTestId('folders').textContent).toBe('');
  });

  it('keeps a renamed chat title when a load started before the rename lands after it', async () => {
    const before: ChatFolderSnapshot = {
      folders: [],
      assignments: [],
      folderSessions: [],
      unfiledSessions: [
        {
          sessionId: 'session-1',
          title: 'Old title',
          updatedAt: new Date('2026-11-18T00:00:00.000Z'),
          agentName: null,
          isMutable: true,
        },
      ],
    };
    const { store, releaseLoad } = deferredLaterLoads(before);
    let captured: FolderContextValue = null;
    render(
      <ChatFolderProvider store={store}>
        <Probe
          capture={value => {
            captured = value;
          }}
        />
      </ChatFolderProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('titles')).toHaveTextContent('Old title');
    });

    act(() => {
      captured?.reload();
    });
    act(() => {
      captured?.updateFolderSessionTitle({ sessionId: 'session-1', title: 'New title' });
    });
    expect(screen.getByTestId('titles')).toHaveTextContent('New title');

    await act(async () => {
      releaseLoad(before);
    });

    expect(screen.getByTestId('titles')).toHaveTextContent('New title');
  });
});

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
  return <div data-testid="unfiled">{(value?.unfiledSessions ?? []).map(session => session.sessionId).join(',')}</div>;
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

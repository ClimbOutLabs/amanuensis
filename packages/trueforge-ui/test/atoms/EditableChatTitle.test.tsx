// @vitest-environment jsdom
import { AssistantRuntimeProvider, useExternalStoreRuntime, type ThreadMessageLike } from '@assistant-ui/react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { NamedAgentHeaderLabel } from '@/atoms/NamedAgentHeaderLabel.js';
import { ServerProvider } from '@/server/ServerContext.js';
import { ShellModeProvider } from '@/server/ShellModeContext.js';
import type { AgentUIServer } from '@/server/types.js';
import { createMockAgentUIServer } from '../server/mockServer.js';

type UpdateSession = AgentUIServer['updateSession'];

/** A chat with a server id and a sidebar title, so the header shows the chat title. */
function TitledChatHarness({ children, onRename }: { children: ReactNode; onRename: (title: string) => void }) {
  const [title, setTitle] = useState('Hello chat, how are you');
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages: [],
    convertMessage: message => message,
    onNew: async () => {},
    adapters: {
      threadList: {
        threadId: 'thread-1',
        threads: [{ status: 'regular', id: 'thread-1', remoteId: 'session-1', title }],
        onRename: async (_threadId, newTitle) => {
          onRename(newTitle);
          setTitle(newTitle);
        },
      },
    },
  });

  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}

function renderHeader({ failWith }: { failWith?: string } = {}) {
  const onRename = vi.fn();
  const updateSession = vi.fn<UpdateSession>(async request => {
    if (failWith !== undefined) throw new Error(failWith);
    return {
      id: request.sessionId,
      isMutable: true,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      title: request.title,
    };
  });
  render(
    <ServerProvider server={createMockAgentUIServer({ updateSession })}>
      <ShellModeProvider agentConfig={{ mode: 'AgentComposer' }}>
        <TitledChatHarness onRename={onRename}>
          <NamedAgentHeaderLabel />
        </TitledChatHarness>
      </ShellModeProvider>
    </ServerProvider>,
  );
  return { onRename, updateSession };
}

async function startRename() {
  fireEvent.click(screen.getByRole('button', { name: 'Rename chat' }));
  return screen.getByRole('textbox', { name: 'Chat title' });
}

describe('NamedAgentHeaderLabel inline chat rename', () => {
  it('saves on Enter through updateSession and renames the sidebar row', async () => {
    const { onRename, updateSession } = renderHeader();

    const input = await startRename();
    fireEvent.change(input, { target: { value: '  Trip to Lisbon  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(updateSession).toHaveBeenCalledWith({ sessionId: 'session-1', title: 'Trip to Lisbon' });
      expect(onRename).toHaveBeenCalledWith('Trip to Lisbon');
    });
    expect(screen.queryByRole('textbox', { name: 'Chat title' })).not.toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Rename chat' })).toHaveTextContent('Trip to Lisbon');
    });
  });

  it('cancels on Escape without calling updateSession', async () => {
    const { updateSession } = renderHeader();

    const input = await startRename();
    fireEvent.change(input, { target: { value: 'Something else' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    fireEvent.blur(input);

    expect(updateSession).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox', { name: 'Chat title' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Rename chat' })).toHaveTextContent('Hello chat, how are you');
  });

  it('ignores an empty or whitespace-only title on Enter', async () => {
    const { updateSession } = renderHeader();

    const input = await startRename();
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(updateSession).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: 'Chat title' })).toBeInTheDocument();
  });

  it('saves a changed title on blur', async () => {
    const { updateSession } = renderHeader();

    const input = await startRename();
    fireEvent.change(input, { target: { value: 'Budget review' } });
    fireEvent.blur(input);

    await waitFor(() => {
      expect(updateSession).toHaveBeenCalledWith({ sessionId: 'session-1', title: 'Budget review' });
    });
  });

  it('restores the old title on blur when the field is blank', async () => {
    const { updateSession } = renderHeader();

    const input = await startRename();
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);

    expect(updateSession).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Rename chat' })).toHaveTextContent('Hello chat, how are you');
  });

  it('keeps the field open with an alert when the save fails', async () => {
    renderHeader({ failWith: 'Server is busy' });

    const input = await startRename();
    fireEvent.change(input, { target: { value: 'New name' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(await screen.findByRole('alert')).toHaveTextContent('Server is busy');
    expect(screen.getByRole('textbox', { name: 'Chat title' })).toBeInTheDocument();
  });
});

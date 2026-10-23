// @vitest-environment jsdom
import { ThreadPrimitive, type ThreadMessageLike } from '@assistant-ui/react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { AssistantMessageContainer } from '@/containers/AssistantMessageContainer.js';
import { AgentDetailsPreferenceProvider, useAgentDetailsVisibility } from '@/server/AgentDetailsPreferenceContext.js';
import { ServerProvider } from '@/server/ServerContext.js';
import type { AgentUIServer, Session, UpdateSessionRequest } from '@/server/types.js';
import { RuntimeHarness } from '../containers/RuntimeHarness.js';
import { createMockAgentUIServer } from './mockServer.js';

const SESSION_ID = 'session-agent-details';

/** In-memory session-metadata store, standing in for the backend `SessionMetadataSchema` row. */
function createMetadataBackedServer(initialMetadata: Record<string, string> = {}): AgentUIServer {
  const metadataById = new Map<string, Record<string, string>>([[SESSION_ID, initialMetadata]]);

  return createMockAgentUIServer({
    getSession: async ({ sessionId }) => {
      const session: Session & { metadata: Record<string, string> } = {
        id: sessionId,
        isMutable: true,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        metadata: metadataById.get(sessionId) ?? {},
      };
      return session;
    },
    updateSession: async (request: UpdateSessionRequest & { metadata?: Record<string, string> }) => {
      const current = metadataById.get(request.sessionId) ?? {};
      const nextMetadata = request.metadata === undefined ? current : { ...current, ...request.metadata };
      metadataById.set(request.sessionId, nextMetadata);
      const session: Session & { metadata: Record<string, string> } = {
        id: request.sessionId,
        isMutable: true,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        metadata: nextMetadata,
      };
      return session;
    },
  });
}

/** Stand-in for the sidebar's "Show agent details" menu item, driving the same hook. */
function AgentDetailsToggle({ sessionId }: { sessionId: string }) {
  const { visible, setVisibility } = useAgentDetailsVisibility(sessionId);
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={visible}
      onClick={() => void setVisibility(visible ? 'collapsed' : 'expanded')}
    >
      Show agent details
    </button>
  );
}

function completedToolTurn(id: string): ThreadMessageLike {
  return {
    id,
    role: 'assistant',
    content: [
      { type: 'reasoning', text: 'private reasoning' },
      {
        type: 'tool-call',
        toolCallId: `tool-done-${id}`,
        toolName: 'lookup_notes',
        args: {},
        argsText: '{}',
        result: { ok: true },
      },
      { type: 'text', text: 'Here is what I found.' },
    ],
  };
}

function renderChat(server: AgentUIServer, messages: ThreadMessageLike[]) {
  return render(
    <ServerProvider server={server}>
      <AgentDetailsPreferenceProvider>
        <AgentDetailsToggle sessionId={SESSION_ID} />
        <RuntimeHarness messages={messages} threadId="thread-1" remoteId={SESSION_ID}>
          <ThreadPrimitive.Messages>{() => <AssistantMessageContainer />}</ThreadPrimitive.Messages>
        </RuntimeHarness>
      </AgentDetailsPreferenceProvider>
    </ServerProvider>,
  );
}

describe('AgentDetailsPreferenceContext', () => {
  it("toggling the chat-level switch shows the existing turn's steps", async () => {
    const server = createMetadataBackedServer();
    renderChat(server, [completedToolTurn('turn-1')]);

    // Starts off (no stored preference yet): no step row at all.
    expect(screen.queryByTestId('assistant-message-agent-internals')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('menuitemcheckbox')).toHaveAttribute('aria-checked', 'false'));

    act(() => screen.getByRole('menuitemcheckbox').click());
    await waitFor(() => expect(screen.getByRole('menuitemcheckbox')).toHaveAttribute('aria-checked', 'true'));

    const internals = screen.getByTestId('assistant-message-agent-internals');
    expect(internals.querySelector('[hidden]')).toBeNull();
  });

  it('a turn that arrives after the switch is already on renders expanded too', async () => {
    // The switch was turned on earlier in this chat (metadata already carries it), then a second
    // turn happened. The chat-level preference, not per-turn state, decides how it renders.
    const server = createMetadataBackedServer({ agent_details: 'expanded' });
    renderChat(server, [completedToolTurn('turn-1'), { role: 'user', content: 'thanks' }, completedToolTurn('turn-2')]);

    await waitFor(() => expect(screen.getByRole('menuitemcheckbox')).toHaveAttribute('aria-checked', 'true'));
    const internalsRows = screen.getAllByTestId('assistant-message-agent-internals');
    expect(internalsRows).toHaveLength(2);
    for (const row of internalsRows) {
      expect(row.querySelector('[hidden]')).toBeNull();
    }
  });

  it("turning the switch off removes every turn's step row", async () => {
    const server = createMetadataBackedServer({ agent_details: 'expanded' });
    renderChat(server, [completedToolTurn('turn-1'), { role: 'user', content: 'thanks' }, completedToolTurn('turn-2')]);

    await waitFor(() => expect(screen.getByRole('menuitemcheckbox')).toHaveAttribute('aria-checked', 'true'));
    const internalsRows = screen.getAllByTestId('assistant-message-agent-internals');
    expect(internalsRows).toHaveLength(2);
    for (const row of internalsRows) {
      expect(row.querySelector('[hidden]')).toBeNull();
    }

    act(() => screen.getByRole('menuitemcheckbox').click());
    await waitFor(() => expect(screen.getByRole('menuitemcheckbox')).toHaveAttribute('aria-checked', 'false'));
    expect(screen.queryByTestId('assistant-message-agent-internals')).not.toBeInTheDocument();
  });

  it('persists across a remount: a fresh provider re-reads the stored preference', async () => {
    const server = createMetadataBackedServer();
    const { unmount } = renderChat(server, [completedToolTurn('turn-1')]);

    await waitFor(() => expect(screen.getByRole('menuitemcheckbox')).toHaveAttribute('aria-checked', 'false'));
    act(() => screen.getByRole('menuitemcheckbox').click());
    await waitFor(() => expect(screen.getByRole('menuitemcheckbox')).toHaveAttribute('aria-checked', 'true'));

    unmount();

    // A brand new provider instance (as after navigating away and back) re-reads the session.
    renderChat(server, [completedToolTurn('turn-1')]);
    await waitFor(() => expect(screen.getByRole('menuitemcheckbox')).toHaveAttribute('aria-checked', 'true'));
    expect(screen.getByTestId('assistant-message-agent-internals').querySelector('[hidden]')).toBeNull();
  });

  it('keeps details on while a turn runs when the first read of the setting fails', async () => {
    // The first read never reaches the server (often the first request after a phone wakes).
    const stored = createMetadataBackedServer({ agent_details: 'expanded' });
    let reads = 0;
    const server: AgentUIServer = {
      ...stored,
      getSession: async request => {
        reads += 1;
        if (reads === 1) throw new TypeError('Failed to fetch');
        return stored.getSession(request);
      },
    };
    render(
      <ServerProvider server={server}>
        <AgentDetailsPreferenceProvider>
          <RuntimeHarness
            messages={[completedToolTurn('turn-1'), { role: 'user', content: 'and now?' }]}
            isRunning
            threadId="thread-1"
            remoteId={SESSION_ID}
          >
            <ThreadPrimitive.Messages>{() => <AssistantMessageContainer />}</ThreadPrimitive.Messages>
          </RuntimeHarness>
        </AgentDetailsPreferenceProvider>
      </ServerProvider>,
    );

    // The earlier turn keeps its details, and the running turn shows its live row.
    await waitFor(() => expect(screen.getAllByTestId('assistant-message-agent-internals')).toHaveLength(2), {
      timeout: 3000,
    });
    expect(screen.getAllByTestId('assistant-message-agent-internals')[1]?.textContent).toContain('Waiting for model');
  });

  it('a slow first read does not undo the switch the person turned on meanwhile', async () => {
    const stored = createMetadataBackedServer();
    let releaseFirstRead: () => void = () => undefined;
    let reads = 0;
    const server: AgentUIServer = {
      ...stored,
      getSession: async request => {
        reads += 1;
        // Read the stored value now, answer later, as a busy server does.
        const answer = await stored.getSession(request);
        if (reads === 1) {
          await new Promise<void>(resolve => {
            releaseFirstRead = resolve;
          });
        }
        return answer;
      },
    };
    renderChat(server, [completedToolTurn('turn-1')]);

    act(() => screen.getByRole('menuitemcheckbox').click());
    await waitFor(() => expect(screen.getByRole('menuitemcheckbox')).toHaveAttribute('aria-checked', 'true'));

    await act(async () => releaseFirstRead());
    expect(screen.getByRole('menuitemcheckbox')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('assistant-message-agent-internals')).toBeInTheDocument();
  });
});

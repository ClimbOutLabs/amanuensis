// @vitest-environment jsdom
import { ThreadPrimitive, type ThreadMessageLike } from '@assistant-ui/react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AssistantMessageContainer } from '@/containers/AssistantMessageContainer.js';

import { RuntimeHarness } from './RuntimeHarness.js';

const state = vi.hoisted(() => ({
  server: null as Record<string, unknown> | null,
  reload: vi.fn(),
}));

vi.mock('@/server/ServerContext.js', async importOriginal => {
  const actual = await importOriginal<typeof import('@/server/ServerContext.js')>();
  return { ...actual, useOptionalServer: () => state.server };
});

vi.mock('@truefoundry/assistant-ui-runtime', async importOriginal => {
  const actual = await importOriginal<typeof import('@truefoundry/assistant-ui-runtime')>();
  return { ...actual, useTrueFoundryReload: () => state.reload };
});

const SESSION_ID = 'session-1';
const CARD_ID = 'call-send';

/** The newest message asks for an approval on the chat's own thread; nothing has answered it. */
const newestPendingCard: ThreadMessageLike[] = [
  {
    role: 'assistant',
    content: [
      {
        type: 'tool-call',
        toolCallId: CARD_ID,
        toolName: 'send_note',
        args: {},
        interrupt: { type: 'human', payload: {} },
        approval: {
          id: CARD_ID,
          approved: undefined,
          options: [
            { id: 'allow-once', kind: 'allow-once' as const },
            { id: 'deny', kind: 'reject-once' as const, confirm: {} },
          ],
        },
      },
    ],
    status: { type: 'requires-action', reason: 'tool-calls' },
  },
];

function renderCard(messages: ThreadMessageLike[]) {
  return render(
    <RuntimeHarness messages={messages} threadId="thread-1" remoteId={SESSION_ID}>
      <ThreadPrimitive.Messages>{() => <AssistantMessageContainer />}</ThreadPrimitive.Messages>
    </RuntimeHarness>,
  );
}

/** A server whose tip read names the cards still waiting; the rest of the chat port is not used here. */
function fakeServer(waitingIds: string[]) {
  return {
    peekSessionTip: vi.fn(async () => ({
      turnId: 'turn-tip',
      status: 'done',
      pendingApprovals: waitingIds.map(toolCallId => ({
        toolCallId,
        threadId: 'main',
        createdAt: '2026-10-22T10:00:00.000Z',
      })),
    })),
    dismissPendingApprovals: vi.fn(),
    answerHeldAction: vi.fn(),
    getLastCompactionStatus: vi.fn(),
    getLastTurnInputTokens: vi.fn(),
    dismissEndedApproval: vi.fn(async () => undefined),
  };
}

describe('a card whose request ended', () => {
  beforeEach(() => {
    state.reload.mockClear();
    state.server = null;
  });

  it('shows the ended note with Dismiss and no Approve or Deny, even on the newest message', async () => {
    const server = fakeServer([]);
    state.server = server;
    renderCard(newestPendingCard);

    expect(await screen.findByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
    expect(screen.getByText('This request ended. Ask again if you still need it.')).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'Approve' })).not.toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'Deny' })).not.toBeInTheDocument();
  });

  it('Dismiss clears the card at once, asks the server to deny it without running it, and reloads', async () => {
    const server = fakeServer([]);
    state.server = server;
    renderCard(newestPendingCard);

    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));

    await waitFor(() => {
      expect(screen.queryByText('This request ended. Ask again if you still need it.')).not.toBeInTheDocument();
    });
    expect(server.dismissEndedApproval).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      threadId: 'main',
      toolCallId: CARD_ID,
    });
    expect(state.reload).toHaveBeenCalledOnce();
  });

  it('keeps Approve and Deny on a request the server still lists as waiting', async () => {
    state.server = fakeServer([CARD_ID]);
    renderCard(newestPendingCard);

    expect(await screen.findByRole('radio', { name: 'Approve' })).toBeInTheDocument();
    expect(screen.queryByText('This request ended. Ask again if you still need it.')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument();
  });
});

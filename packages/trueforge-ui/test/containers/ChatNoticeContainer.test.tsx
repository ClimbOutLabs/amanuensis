// @vitest-environment jsdom
//
// A chat opened after a restart ended its last reply says why there is no reply, from what the
// chat loads, not only from what the open page saw happen.
import { ThreadPrimitive } from '@assistant-ui/react';
import { render, screen, waitFor } from '@testing-library/react';
import type { Session, SessionEventItem, Turn } from '@truefoundry/assistant-ui-runtime/server';
import { describe, expect, it } from 'vitest';

import { EMPTY_PERSONALIZATION_PROFILE, PersonalizationProvider } from '@/components/PersonalizationContext.js';
import { ChatNoticeContainer } from '@/containers/ChatNoticeContainer.js';
import { TrueFoundryChatProvider } from '@/containers/TrueFoundryChatProvider.js';
import { ComposerBusyProvider } from '@/hooks/useComposerBusyState.js';
import { sendRefusalText } from '@/utils/turnRefusal.js';
import { createMockAgentUIServer } from '../server/mockServer.js';

const sessionId = 'session-ended-by-restart';
const createdAt = '2026-10-23T09:00:00.000Z';
const ASSISTANT_NAME = 'Juniper';

function endedTurn({ turnId, reason }: { turnId: string; reason: string }): SessionEventItem[] {
  const events: SessionEventItem['event'][] = [
    {
      type: 'turn.created',
      id: `created-${turnId}`,
      turnId,
      input: [{ type: 'user.message', content: 'Tell me about Lantern Row' }],
      state: { status: 'running' },
      createdAt,
    },
    {
      type: 'turn.done',
      id: `done-${turnId}`,
      state: { status: 'cancelled', reason, completedAt: createdAt },
      createdAt,
    },
  ];
  return events.map(event => ({ turnId, event }));
}

function renderSavedChat(items: SessionEventItem[]) {
  const session: Session = { id: sessionId, agentName: 'agent', isMutable: false, createdAt, updatedAt: createdAt };
  const turns: Turn[] = [];
  const server = createMockAgentUIServer({
    getSession: async () => session,
    listSessions: async () => ({ data: [session] }),
    listTurns: async () => ({ data: turns }),
    // Newest first, as the server lists them.
    listEvents: async () => ({ data: [...items].reverse() }),
  });
  render(
    <PersonalizationProvider
      api={{
        getProfile: async () => ({ ...EMPTY_PERSONALIZATION_PROFILE, assistant_name: ASSISTANT_NAME }),
        updateProfile: async profile => profile,
        deleteProfile: async () => {},
      }}
    >
      <TrueFoundryChatProvider server={server} agentName="agent" initialSessionId={sessionId}>
        <ComposerBusyProvider>
          <ThreadPrimitive.Messages>
            {({ message }) => <p data-role={message.role}>{message.role === 'user' ? 'your message' : 'a reply'}</p>}
          </ThreadPrimitive.Messages>
          <ChatNoticeContainer />
        </ComposerBusyProvider>
      </TrueFoundryChatProvider>
    </PersonalizationProvider>,
  );
}

describe('ChatNoticeContainer on a loaded chat', () => {
  it('says once, in the reply place and with the assistant name, that a restart stopped the last reply', async () => {
    renderSavedChat(endedTurn({ turnId: 'turn-restarted', reason: 'abandoned' }));
    const line = sendRefusalText({ refusal: 'stopped_by_restart', assistantName: ASSISTANT_NAME });

    await screen.findByText('your message');
    await waitFor(() => expect(screen.getAllByText(line)).toHaveLength(1));
    expect(screen.getByText(line).closest('[data-role="assistant"]')).not.toBeNull();
  });

  it('says that a reply could not start when that is why it ended', async () => {
    renderSavedChat(endedTurn({ turnId: 'turn-never-started', reason: 'could-not-start' }));
    const line = sendRefusalText({ refusal: 'turn_could_not_start', assistantName: ASSISTANT_NAME });

    await waitFor(() => expect(screen.getAllByText(line)).toHaveLength(1));
  });

  it('says nothing when the person pressed Stop', async () => {
    renderSavedChat(endedTurn({ turnId: 'turn-cancelled', reason: 'client-cancelled' }));

    await screen.findByText('your message');
    expect(screen.queryByRole('status')).toBeNull();
  });
});

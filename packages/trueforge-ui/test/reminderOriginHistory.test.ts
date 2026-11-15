import type { ThreadMessage } from '@assistant-ui/core';
import type {
  AgentChatServer,
  ModelMessageEvent,
  Session,
  SessionEventItem,
  TurnCreatedEvent,
  TurnDoneEvent,
} from '@truefoundry/assistant-ui-runtime/server';
import { describe, expect, it } from 'vitest';

import { projectSessionMessages } from '../node_modules/@truefoundry/assistant-ui-runtime/src/convertTurnMessages.js';
import { loadSessionSnapshot } from '../node_modules/@truefoundry/assistant-ui-runtime/src/loadSessionSnapshot.js';

/**
 * The events of one chat, in the wire shapes the chat server hands the chat view: first the finished turn where
 * the person asked for the reminder, then the fired reminder itself, written by the host as a turn with no
 * message of its own and one model message holding the reminder line.
 */
const sessionId = 'chat-medicine';
const reminderLine = 'Reminder: Take the medicine\n\nDue Monday, October 19 at 6:00 PM.';

function created(input: {
  id: string;
  turnId: string;
  previousTurnId: string | null;
  userText?: string;
  createdAt: string;
}): TurnCreatedEvent {
  return {
    type: 'turn.created',
    id: input.id,
    turnId: input.turnId,
    previousTurnId: input.previousTurnId,
    ...(input.userText === undefined ? {} : { input: [{ type: 'user.message' as const, content: input.userText }] }),
    state: { status: 'running' },
    createdAt: input.createdAt,
    threadId: null,
  };
}

function modelMessage(input: { id: string; text: string; createdAt: string }): ModelMessageEvent {
  return {
    type: 'model.message',
    id: input.id,
    threadId: 'main',
    content: input.text,
    finishReason: 'stop',
    createdAt: input.createdAt,
  };
}

function done(input: { id: string; createdAt: string }): TurnDoneEvent {
  return {
    type: 'turn.done',
    id: input.id,
    state: { status: 'done', requiredActions: [], completedAt: input.createdAt },
    createdAt: input.createdAt,
    threadId: null,
  };
}

const items: SessionEventItem[] = [
  {
    turnId: 'turn-set',
    event: created({
      id: 'evt-1',
      turnId: 'turn-set',
      previousTurnId: null,
      userText: 'Remind me to take the medicine at 6 PM.',
      createdAt: '2026-10-19T21:00:00.000Z',
    }),
  },
  {
    turnId: 'turn-set',
    event: modelMessage({
      id: 'evt-2',
      text: 'Done, I will remind you at 6 PM.',
      createdAt: '2026-10-19T21:00:01.000Z',
    }),
  },
  { turnId: 'turn-set', event: done({ id: 'evt-3', createdAt: '2026-10-19T21:00:01.000Z' }) },
  {
    turnId: 'turn-reminder',
    event: created({
      id: 'evt-4',
      turnId: 'turn-reminder',
      previousTurnId: 'turn-set',
      createdAt: '2026-10-19T22:00:05.000Z',
    }),
  },
  {
    turnId: 'turn-reminder',
    event: modelMessage({ id: 'evt-5', text: reminderLine, createdAt: '2026-10-19T22:00:05.000Z' }),
  },
  { turnId: 'turn-reminder', event: done({ id: 'evt-6', createdAt: '2026-10-19T22:00:05.000Z' }) },
];

function serverWithHistory(): AgentChatServer {
  const session: Session = {
    id: sessionId,
    isMutable: false,
    createdAt: '2026-10-19T21:00:00.000Z',
    updatedAt: '2026-10-19T22:00:05.000Z',
  };
  return {
    createSession: async () => {
      throw new Error('createSession is not used by this fixture');
    },
    listSessions: async () => ({ data: [] }),
    getSession: async () => session,
    updateSession: async () => {
      throw new Error('updateSession is not used by this fixture');
    },
    createTurn: async function* () {
      yield* [];
    },
    cancelSession: async () => undefined,
    listTurns: async () => ({ data: [] }),
    getTurn: async () => {
      throw new Error('getTurn is not used by this fixture');
    },
    // The session events endpoint answers newest first; the snapshot loader puts them back in order.
    listEvents: async () => ({ data: [...items].reverse() }),
  };
}

function textOf(message: ThreadMessage): string {
  return message.content
    .filter(part => part.type === 'text')
    .map(part => part.text)
    .join('\n');
}

describe('a fired reminder in the history of the chat it was set in', () => {
  it('shows in the rebuilt history the chat view reads, joined to the answer above it', async () => {
    const snapshot = await loadSessionSnapshot(serverWithHistory(), sessionId);
    const messages = projectSessionMessages(snapshot);

    // The reminder turn starts no group of its own: the chat still reads as one question and one answer.
    expect(messages).toHaveLength(2);
    const [user, assistant] = messages;
    expect(user?.role).toBe('user');
    expect(user === undefined ? '' : textOf(user)).toContain('Remind me to take the medicine at 6 PM.');
    expect(assistant?.role).toBe('assistant');
    const answer = assistant === undefined ? '' : textOf(assistant);
    expect(answer).toContain('Done, I will remind you at 6 PM.');
    expect(answer).toContain(reminderLine);
  });
});

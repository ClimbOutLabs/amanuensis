// @vitest-environment jsdom
//
// A chat reloaded while a reply is still being written must show only that reply in the running turn.
// The running turn is not a finished turn yet, so the runtime used to treat the last finished turn as the
// start of the running turn's group and showed that turn's reply inside the new one.
import { act, renderHook, waitFor } from '@testing-library/react';
import type {
  AgentChatServer,
  Session,
  SessionEventItem,
  Turn,
  TurnStreamData,
} from '@truefoundry/assistant-ui-runtime/server';
import { describe, expect, it } from 'vitest';

import { useTrueFoundryAgentMessages } from '../node_modules/@truefoundry/assistant-ui-runtime/src/useTrueFoundryAgentMessages.js';

const sessionId = 'reload-mid-turn-session';
const rootThreadId = 'main';
const createdAt = '2026-09-06T00:00:00.000Z';

const FIRST_QUESTION = 'Tell me about harbour lights';
const FIRST_REPLY = 'Harbour lights guide ships in.';
const SECOND_QUESTION = 'Next tell me about tide tables';
const SECOND_REPLY = 'Tide tables list the daily water levels.';
const THIRD_QUESTION = 'Now tell me about lighthouse keepers';
const THIRD_REPLY = 'Lighthouse keepers tend the lamp.';

function userInput(text: string): NonNullable<Turn['input']> {
  return [{ type: 'user.message', content: text }];
}

function turnCreated({ turnId, question }: { turnId: string; question: string }): SessionEventItem {
  return {
    turnId,
    event: {
      type: 'turn.created',
      id: `created-${turnId}`,
      turnId,
      input: userInput(question),
      state: { status: 'running' },
      createdAt,
    },
  };
}

function modelMessage({ turnId, text }: { turnId: string; text: string }): SessionEventItem {
  return {
    turnId,
    event: { type: 'model.message', id: `model-${turnId}`, threadId: rootThreadId, content: text, createdAt },
  };
}

function turnDone(turnId: string): SessionEventItem {
  return {
    turnId,
    event: {
      type: 'turn.done',
      id: `done-${turnId}`,
      state: { status: 'done', requiredActions: [], completedAt: createdAt },
      createdAt,
    },
  };
}

function finishedTurn({ turnId, question, reply }: { turnId: string; question: string; reply: string }) {
  return [turnCreated({ turnId, question }), modelMessage({ turnId, text: reply }), turnDone(turnId)];
}

const runningTurn: Turn = {
  id: 'turn-3',
  sessionId,
  state: { status: 'running' },
  input: userInput(THIRD_QUESTION),
  createdAt,
};

/** Two finished turns, then a third that is still being written when the chat is opened. */
function createReloadedServer({ listsRunningTurnEvents }: { listsRunningTurnEvents: boolean }): AgentChatServer {
  const oldestFirst = [
    ...finishedTurn({ turnId: 'turn-1', question: FIRST_QUESTION, reply: FIRST_REPLY }),
    ...finishedTurn({ turnId: 'turn-2', question: SECOND_QUESTION, reply: SECOND_REPLY }),
    ...(listsRunningTurnEvents ? [turnCreated({ turnId: 'turn-3', question: THIRD_QUESTION })] : []),
  ];
  return {
    createSession: async () => {
      throw new Error('createSession is not used by this fixture');
    },
    listSessions: async () => ({ data: [] }),
    getSession: async ({ sessionId: id }): Promise<Session> => ({
      id,
      agentName: 'agent',
      isMutable: false,
      createdAt,
      updatedAt: createdAt,
    }),
    updateSession: async () => {
      throw new Error('updateSession is not used by this fixture');
    },
    cancelSession: async () => undefined,
    createTurn: () => {
      throw new Error('createTurn is not used by this fixture');
    },
    listTurns: async () => ({ data: [runningTurn] }),
    getTurn: async () => runningTurn,
    listTurnEvents: async () => ({ data: [] }),
    listEvents: async () => ({ data: [...oldestFirst].reverse() }),
    subscribeToTurn: async function* ({ abortSignal }): AsyncGenerator<TurnStreamData> {
      yield { sequenceNumber: 0, event: modelMessage({ turnId: 'turn-3', text: THIRD_REPLY }).event };
      await new Promise<void>(resolve => {
        abortSignal?.addEventListener('abort', () => {
          resolve();
        });
      });
    },
  };
}

describe('a chat reloaded while a reply is being written', () => {
  it.each([
    { name: 'the running turn is left out of the event list', listsRunningTurnEvents: false },
    { name: 'the running turn is in the event list', listsRunningTurnEvents: true },
  ])('shows nothing of the earlier turns in the running turn when $name', async ({ listsRunningTurnEvents }) => {
    const server = createReloadedServer({ listsRunningTurnEvents });
    const { result, unmount } = renderHook(() => useTrueFoundryAgentMessages({ server, sessionId, isMain: true }));

    await waitFor(() => {
      expect(JSON.stringify(result.current.messages.at(-1)?.content)).toContain(THIRD_REPLY);
    });
    await act(async () => undefined);

    const messages = result.current.messages;
    const live = JSON.stringify(messages.at(-1)?.content);
    for (const earlier of [FIRST_QUESTION, FIRST_REPLY, SECOND_QUESTION, SECOND_REPLY]) {
      expect(live).not.toContain(earlier);
    }
    expect(messages.map(message => message.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
    const everything = JSON.stringify(messages);
    for (const once of [FIRST_QUESTION, FIRST_REPLY, SECOND_QUESTION, SECOND_REPLY, THIRD_QUESTION, THIRD_REPLY]) {
      expect(everything.split(once)).toHaveLength(2);
    }
    unmount();
  });
});

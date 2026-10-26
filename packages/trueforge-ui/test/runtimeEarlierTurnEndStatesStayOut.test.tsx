// @vitest-environment jsdom
//
// A new message must start a new group whatever way the turn before it ended: finished, cancelled,
// failed, or never written an end event (the worker stopped, the stream was cut). The earlier
// turn's reply must never show inside the new running turn. Agent details only change how the
// running turn's parts are drawn, so the parts are checked here.
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

const sessionId = 'earlier-turn-end-state-session';
const rootThreadId = 'main';
const createdAt = '2026-10-26T00:00:00.000Z';

const FIRST_QUESTION = 'Help me plan a harbour walk';
const FIRST_REPLY = 'Harbour walks start at the lighthouse steps.';
const SECOND_QUESTION = 'you stopped';
const SECOND_REPLY = 'Here is the full plan for the harbour walk.';

type EndState = 'done' | 'cancelled' | 'error' | 'never-ended';
const endStates: EndState[] = ['done', 'cancelled', 'error', 'never-ended'];

function terminalState(endState: Exclude<EndState, 'never-ended'>) {
  switch (endState) {
    case 'done':
      return { status: 'done' as const, requiredActions: [], completedAt: createdAt };
    case 'cancelled':
      return { status: 'cancelled' as const, reason: 'client_cancelled', completedAt: createdAt };
    case 'error':
      return { status: 'error' as const, message: 'The model stopped answering.', completedAt: createdAt };
  }
}

function userInput(text: string): NonNullable<Turn['input']> {
  return [{ type: 'user.message', content: text }];
}

function turnCreated({ turnId, question }: { turnId: string; question: string }) {
  return {
    type: 'turn.created' as const,
    id: `created-${turnId}`,
    turnId,
    input: userInput(question),
    state: { status: 'running' as const },
    createdAt,
  };
}

function modelMessage({ turnId, text }: { turnId: string; text: string }) {
  return { type: 'model.message' as const, id: `model-${turnId}`, threadId: rootThreadId, content: text, createdAt };
}

function turnDone({ turnId, endState }: { turnId: string; endState: Exclude<EndState, 'never-ended'> }) {
  return { type: 'turn.done' as const, id: `done-${turnId}`, state: terminalState(endState), createdAt };
}

/** A turn that stopped without writing its end event leaves no `turn.done` behind. */
function endEvents({ turnId, endState }: { turnId: string; endState: EndState }) {
  return endState === 'never-ended' ? [] : [turnDone({ turnId, endState })];
}

function asItem(event: TurnStreamData['event'], turnId: string): SessionEventItem {
  return { turnId, event };
}

async function* eventsOf(events: TurnStreamData['event'][]): AsyncGenerator<TurnStreamData> {
  let sequenceNumber = 0;
  for (const event of events) {
    yield { sequenceNumber: sequenceNumber++, event };
  }
}

function baseServer(): Omit<AgentChatServer, 'createTurn' | 'listTurns' | 'getTurn' | 'listEvents'> {
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
  };
}

const runningTurn: Turn = {
  id: 'turn-2',
  sessionId,
  state: { status: 'running' },
  input: userInput(SECOND_QUESTION),
  createdAt,
};

function reloadedServer(endState: EndState): AgentChatServer {
  const history = [
    asItem(turnCreated({ turnId: 'turn-1', question: FIRST_QUESTION }), 'turn-1'),
    asItem(modelMessage({ turnId: 'turn-1', text: FIRST_REPLY }), 'turn-1'),
    ...endEvents({ turnId: 'turn-1', endState }).map(event => asItem(event, 'turn-1')),
    // Without an end event the earlier turn is only known to be over because the next turn started.
    ...(endState === 'never-ended'
      ? [asItem(turnCreated({ turnId: 'turn-2', question: SECOND_QUESTION }), 'turn-2')]
      : []),
  ];
  return {
    ...baseServer(),
    createTurn: () => {
      throw new Error('createTurn is not used by this fixture');
    },
    listTurns: async () => ({ data: [runningTurn] }),
    getTurn: async () => runningTurn,
    listEvents: async () => ({ data: [...history].reverse() }),
    subscribeToTurn: async function* ({ abortSignal }): AsyncGenerator<TurnStreamData> {
      yield { sequenceNumber: 0, event: modelMessage({ turnId: 'turn-2', text: SECOND_REPLY }) };
      await new Promise<void>(resolve => {
        abortSignal?.addEventListener('abort', () => {
          resolve();
        });
      });
    },
  };
}

function liveServer(endState: EndState): AgentChatServer {
  let createTurnCalls = 0;
  return {
    ...baseServer(),
    listTurns: async () => ({ data: [] }),
    getTurn: async () => {
      throw new Error('getTurn is not used by this fixture');
    },
    listEvents: async () => ({ data: [] }),
    createTurn: ({ abortSignal }) => {
      const call = createTurnCalls++;
      if (call === 0) {
        return eventsOf([
          turnCreated({ turnId: 'turn-1', question: FIRST_QUESTION }),
          modelMessage({ turnId: 'turn-1', text: FIRST_REPLY }),
          ...endEvents({ turnId: 'turn-1', endState }),
        ]);
      }
      return (async function* (): AsyncGenerator<TurnStreamData> {
        yield { sequenceNumber: 0, event: turnCreated({ turnId: 'turn-2', question: SECOND_QUESTION }) };
        yield { sequenceNumber: 1, event: modelMessage({ turnId: 'turn-2', text: SECOND_REPLY }) };
        await new Promise<void>(resolve => {
          abortSignal?.addEventListener('abort', () => {
            resolve();
          });
        });
      })();
    },
  };
}

function expectRunningTurnHoldsOnlyItsOwnReply(messages: ReturnType<typeof useTrueFoundryAgentMessages>['messages']) {
  const live = JSON.stringify(messages.at(-1)?.content);
  expect(live).toContain(SECOND_REPLY);
  expect(live).not.toContain(FIRST_REPLY);
  expect(messages.map(message => message.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  const everything = JSON.stringify(messages);
  for (const once of [FIRST_QUESTION, FIRST_REPLY, SECOND_QUESTION, SECOND_REPLY]) {
    expect(everything.split(once)).toHaveLength(2);
  }
}

describe('a running turn that starts with a new message', () => {
  it.each(endStates)('leaves out an earlier turn that ended as %s, after a reload', async endState => {
    const server = reloadedServer(endState);
    const { result, unmount } = renderHook(() => useTrueFoundryAgentMessages({ server, sessionId, isMain: true }));
    await waitFor(() => {
      expect(JSON.stringify(result.current.messages.at(-1)?.content)).toContain(SECOND_REPLY);
    });
    await act(async () => undefined);
    expectRunningTurnHoldsOnlyItsOwnReply(result.current.messages);
    unmount();
  });

  it.each(endStates)('leaves out an earlier turn that ended as %s, without a reload', async endState => {
    const server = liveServer(endState);
    const { result, unmount } = renderHook(() => useTrueFoundryAgentMessages({ server, sessionId, isMain: true }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await act(async () => {
      await result.current.sendTurn({ userMessage: FIRST_QUESTION });
    });
    await waitFor(() => expect(JSON.stringify(result.current.messages)).toContain(FIRST_REPLY));
    act(() => {
      void result.current.sendTurn({ userMessage: SECOND_QUESTION });
    });
    await waitFor(() => {
      expect(JSON.stringify(result.current.messages.at(-1)?.content)).toContain(SECOND_REPLY);
    });
    await act(async () => undefined);
    expectRunningTurnHoldsOnlyItsOwnReply(result.current.messages);
    unmount();
  });
});

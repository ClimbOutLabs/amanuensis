// @vitest-environment jsdom
//
// Reproduces a live-chat bug: a user message that pauses for tool approval
// and then continues across several turns re-renders earlier turns' text on
// every continuation, because the "since group start" baseline used to slice
// each committed turn's root model-message ids never advances past turns
// already committed in the same group. The history-reload path (tested in
// runtimeToolIdentity.test.ts / convertTurnsToThreadMessages) does not have
// this bug because it slices ids per-turn via a before/after count, not via
// a baseline fixed at group start.
import { act, renderHook, waitFor } from '@testing-library/react';
import type { AgentChatServer, Session, TurnStreamData } from '@truefoundry/assistant-ui-runtime/server';
import { describe, expect, it } from 'vitest';

import { useTrueFoundryAgentMessages } from '../node_modules/@truefoundry/assistant-ui-runtime/src/useTrueFoundryAgentMessages.js';

const sessionId = 'live-continuation-session';
const rootThreadId = 'main';
const createdAt = '2026-09-06T00:00:00.000Z';

async function* eventsOf(events: TurnStreamData['event'][]): AsyncGenerator<TurnStreamData> {
  let sequenceNumber = 0;
  for (const event of events) {
    yield { sequenceNumber: sequenceNumber++, event };
  }
}

function turnCreated(turnId: string) {
  return {
    type: 'turn.created' as const,
    id: `created-${turnId}`,
    turnId,
    input: [],
    state: { status: 'running' as const },
    createdAt,
  };
}

function modelMessage(options: { id: string; text: string; toolCallId?: string }) {
  const { id, text, toolCallId } = options;
  return {
    type: 'model.message' as const,
    id,
    threadId: rootThreadId,
    content: text,
    createdAt,
    ...(toolCallId == null
      ? {}
      : {
          toolCalls: [
            {
              id: toolCallId,
              type: 'function' as const,
              function: { name: 'do_thing', arguments: '{}' },
            },
          ],
        }),
  };
}

function approvalRequired(options: { id: string; toolCallId: string; sourceEventId: string }) {
  const { id, toolCallId, sourceEventId } = options;
  return {
    type: 'tool.approval_required' as const,
    id,
    threadId: rootThreadId,
    toolCalls: [{ id: toolCallId, sourceEventId }],
    createdAt,
  };
}

function turnDone(id: string) {
  return {
    type: 'turn.done' as const,
    id,
    state: { status: 'done' as const, requiredActions: [], completedAt: createdAt },
    createdAt,
  };
}

/**
 * Three-turn group: an initial user message that pauses for approval, one
 * approved continuation that pauses again, and a final approved continuation
 * that completes. Each turn's `model.message` carries its own distinct text
 * so a rendering bug that re-emits earlier turns' text is visible directly
 * in the final assistant message's content parts.
 */
function createLiveContinuationServer(): AgentChatServer {
  let createTurnCalls = 0;

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
    listTurns: async () => ({ data: [] }),
    getTurn: async () => {
      throw new Error('getTurn is not used by this fixture');
    },
    listEvents: async () => ({ data: [] }),
    createTurn: () => {
      const call = createTurnCalls++;
      if (call === 0) {
        return eventsOf([
          turnCreated('turn-1'),
          modelMessage({ id: 'model-1', text: 'ALPHA_TEXT', toolCallId: 'call-1' }),
          approvalRequired({ id: 'approval-1', toolCallId: 'call-1', sourceEventId: 'model-1' }),
          turnDone('done-1'),
        ]);
      }
      if (call === 1) {
        return eventsOf([
          turnCreated('turn-2'),
          modelMessage({ id: 'model-2', text: 'BETA_TEXT', toolCallId: 'call-2' }),
          approvalRequired({ id: 'approval-2', toolCallId: 'call-2', sourceEventId: 'model-2' }),
          turnDone('done-2'),
        ]);
      }
      if (call === 2) {
        return eventsOf([
          turnCreated('turn-3'),
          modelMessage({ id: 'model-3', text: 'GAMMA_TEXT' }),
          turnDone('done-3'),
        ]);
      }
      throw new Error(`unexpected extra createTurn call #${call + 1}`);
    },
  };
}

describe('live turn continuation rendering', () => {
  it('renders each continuation turn text exactly once while streaming, matching history-reload behavior', async () => {
    const server = createLiveContinuationServer();
    const { result } = renderHook(() => useTrueFoundryAgentMessages({ server, sessionId, isMain: true }));

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.sendTurn({ userMessage: 'kick things off' });
    });
    await waitFor(() => {
      const assistant = result.current.messages.at(-1);
      expect(assistant?.role).toBe('assistant');
      expect(assistant?.status?.type).toBe('requires-action');
    });

    await act(async () => {
      await result.current.sendTurn({
        inputs: [
          {
            type: 'user.tool_approval',
            threadId: rootThreadId,
            toolCallId: 'call-1',
            approval: { status: 'allow' },
          },
        ],
      });
    });
    await waitFor(() => {
      const assistant = result.current.messages.at(-1);
      expect(assistant?.status?.type).toBe('requires-action');
    });

    await act(async () => {
      await result.current.sendTurn({
        inputs: [
          {
            type: 'user.tool_approval',
            threadId: rootThreadId,
            toolCallId: 'call-2',
            approval: { status: 'allow' },
          },
        ],
      });
    });
    await waitFor(() => {
      const assistant = result.current.messages.at(-1);
      expect(assistant?.status?.type).toBe('complete');
    });

    // The whole continuation chain must still fold under one assistant
    // message grouped with the single user message.
    expect(result.current.messages.map(message => message.role)).toEqual(['user', 'assistant']);

    const assistant = result.current.messages[1];
    if (assistant?.role !== 'assistant') throw new Error('expected an assistant message');

    const textParts = assistant.content.filter((part): part is { type: 'text'; text: string } => part.type === 'text');
    const alphaCount = textParts.filter(part => part.text === 'ALPHA_TEXT').length;
    const betaCount = textParts.filter(part => part.text === 'BETA_TEXT').length;
    const gammaCount = textParts.filter(part => part.text === 'GAMMA_TEXT').length;

    // Each turn's text must render exactly once, live, without a reload,
    // the same guarantee the history path already provides.
    expect({ alphaCount, betaCount, gammaCount }).toEqual({ alphaCount: 1, betaCount: 1, gammaCount: 1 });
  });
});

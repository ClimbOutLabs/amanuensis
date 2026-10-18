// @vitest-environment jsdom
//
// A reply that continues after a tool approval runs as a new gateway turn. Its live message must
// carry that turn's id, or a file download from the reply asks the server for a turn it never made.
import { act, renderHook, waitFor } from '@testing-library/react';
import type { AgentChatServer, Session, TurnStreamData } from '@truefoundry/assistant-ui-runtime/server';
import { describe, expect, it } from 'vitest';

import { useTrueFoundryAgentMessages } from '../node_modules/@truefoundry/assistant-ui-runtime/src/useTrueFoundryAgentMessages.js';

const sessionId = 'continuation-turn-id-session';
const rootThreadId = 'main';
const createdAt = '2026-10-18T00:00:00.000Z';

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

function modelMessage({ id, text, toolCallId }: { id: string; text: string; toolCallId?: string }) {
  return {
    type: 'model.message' as const,
    id,
    threadId: rootThreadId,
    content: text,
    createdAt,
    ...(toolCallId == null
      ? {}
      : {
          toolCalls: [{ id: toolCallId, type: 'function' as const, function: { name: 'run_code', arguments: '{}' } }],
        }),
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

/** A request that pauses for approval of run_code, then makes the file in the approved turn. */
function approvalThenFileServer(): AgentChatServer {
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
          turnCreated('turn-asked'),
          modelMessage({ id: 'model-1', text: 'I will make the chart.', toolCallId: 'call-1' }),
          {
            type: 'tool.approval_required' as const,
            id: 'approval-1',
            threadId: rootThreadId,
            toolCalls: [{ id: 'call-1', sourceEventId: 'model-1' }],
            createdAt,
          },
          turnDone('done-1'),
        ]);
      }
      if (call === 1) {
        return eventsOf([
          turnCreated('turn-approved'),
          modelMessage({
            id: 'model-2',
            text: '```sandbox_artifacts\n[Weekly food budget chart](/egress/weekly_food_budget.pdf)\n```',
          }),
          turnDone('done-2'),
        ]);
      }
      throw new Error(`unexpected extra createTurn call #${call + 1}`);
    },
  };
}

describe('live reply after a tool approval', () => {
  it('carries the gateway id of the approved turn, so its file downloads from a turn the server has', async () => {
    const server = approvalThenFileServer();
    const { result } = renderHook(() => useTrueFoundryAgentMessages({ server, sessionId, isMain: true }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.sendTurn({ userMessage: 'Make a weekly budget chart as a PDF.' });
    });
    await waitFor(() => expect(result.current.messages.at(-1)?.status?.type).toBe('requires-action'));

    await act(async () => {
      await result.current.sendTurn({
        inputs: [
          { type: 'user.tool_approval', threadId: rootThreadId, toolCallId: 'call-1', approval: { status: 'allow' } },
        ],
      });
    });
    await waitFor(() => expect(result.current.messages.at(-1)?.status?.type).toBe('complete'));

    const assistant = result.current.messages.at(-1);
    expect(assistant?.metadata.custom.turnId).toBe('turn-approved');
  });
});

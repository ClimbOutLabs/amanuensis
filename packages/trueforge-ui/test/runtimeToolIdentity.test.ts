import type { ThreadMessage } from '@assistant-ui/core';
import { collectApprovalInputs, convertTurnsToThreadMessages } from '@truefoundry/assistant-ui-runtime';
import type {
  AgentChatServer,
  ModelMessageEvent,
  SessionEventItem,
  ThreadCreatedEvent,
  ToolApprovalRequiredEvent,
  ToolResponseEvent,
  Turn,
  TurnDoneEvent,
  TurnEvent,
} from '@truefoundry/assistant-ui-runtime/server';
import { describe, expect, it } from 'vitest';

const sessionId = 'session-1';
const rootThreadId = 'main';

function modelMessage({
  id,
  text,
  toolCallId,
  toolName = 'run_shell',
  threadId = rootThreadId,
}: {
  id: string;
  text: string;
  toolCallId?: string;
  toolName?: string;
  threadId?: string;
}): ModelMessageEvent {
  return {
    type: 'model.message',
    id,
    threadId,
    content: text,
    createdAt: '2026-09-05T00:00:00.000Z',
    ...(toolCallId == null
      ? {}
      : {
          toolCalls: [
            {
              id: toolCallId,
              type: 'function',
              function: { name: toolName, arguments: '{}' },
              ...(toolName === 'create_sub_agent' ? { toolInfo: { type: 'truefoundry-system', name: toolName } } : {}),
            },
          ],
        }),
  };
}

function approval({
  id,
  toolCallId,
  sourceEventId,
  threadId = rootThreadId,
}: {
  id: string;
  toolCallId: string;
  sourceEventId: string;
  threadId?: string;
}): ToolApprovalRequiredEvent {
  return {
    type: 'tool.approval_required',
    id,
    threadId,
    toolCalls: [{ id: toolCallId, sourceEventId }],
    createdAt: '2026-09-05T00:00:01.000Z',
  };
}

function response({
  id,
  toolCallId,
  content,
  threadId = rootThreadId,
}: {
  id: string;
  toolCallId: string;
  content: string;
  threadId?: string;
}): ToolResponseEvent {
  return {
    type: 'tool.response',
    id,
    threadId,
    toolCallId,
    content,
    createdAt: '2026-09-05T00:00:02.000Z',
  };
}

function done(
  id: string,
  requiredActions: ToolApprovalRequiredEvent[] = [],
  state: Exclude<Turn['state'], { status: 'running' }> = {
    status: 'done',
    requiredActions,
    completedAt: '2026-09-05T00:00:01.000Z',
  },
): TurnDoneEvent {
  return {
    type: 'turn.done',
    id: `done-${id}`,
    state,
    createdAt: '2026-09-05T00:00:01.000Z',
  };
}

type TurnFixture = Turn & { events: TurnEvent[]; requiredActions: ToolApprovalRequiredEvent[] };

function turn({
  id,
  input,
  events,
  requiredActions = [],
  state = { status: 'done', completedAt: '2026-09-05T00:00:01.000Z' },
}: {
  id: string;
  input: Turn['input'];
  events: TurnEvent[];
  requiredActions?: ToolApprovalRequiredEvent[];
  state?: Turn['state'];
}): TurnFixture {
  return {
    id,
    sessionId,
    input,
    state,
    createdAt: '2026-09-05T00:00:01.000Z',
    events,
    requiredActions,
  };
}

function serverForTurns(turns: TurnFixture[]): AgentChatServer {
  const items: SessionEventItem[] = [];
  for (const current of turns) {
    items.push({
      turnId: current.id,
      event: {
        type: 'turn.created',
        id: `created-${current.id}`,
        turnId: current.id,
        input: current.input ?? [],
        state: { status: 'running' },
        createdAt: current.createdAt,
      },
    });
    for (const event of current.events) items.push({ turnId: current.id, event });
    items.push({
      turnId: current.id,
      event: done(
        current.id,
        current.requiredActions,
        current.state.status === 'running'
          ? {
              status: 'done',
              requiredActions: current.requiredActions,
              completedAt: '2026-09-05T00:00:01.000Z',
            }
          : current.state,
      ),
    });
  }
  return {
    createSession: async () => {
      throw new Error('createSession is not used by this fixture');
    },
    listSessions: async () => ({ data: [] }),
    getSession: async () => {
      throw new Error('getSession is not used by this fixture');
    },
    updateSession: async () => {
      throw new Error('updateSession is not used by this fixture');
    },
    createTurn: async function* () {
      yield* [];
    },
    cancelSession: async () => undefined,
    listTurns: async () => ({ data: [...turns].reverse() }),
    getTurn: async ({ turnId }) => {
      const found = turns.find(current => current.id === turnId);
      if (found == null) throw new Error(`Turn ${turnId} not found`);
      return found;
    },
    listEvents: async () => ({ data: [...items].reverse() }),
    listTurnEvents: async ({ turnId }) => ({
      data: turns.find(current => current.id === turnId)?.events ?? [],
    }),
  };
}

describe('runtime tool invocation identity', () => {
  it('keeps a reused approval tool_call_id distinct across turn groups', async () => {
    const firstApproval = approval({ id: 'approval-first', toolCallId: 'tool-reused', sourceEventId: 'model-first' });
    const firstTurn = turn({
      id: 'turn-first',
      input: [{ type: 'user.message', content: 'first invocation' }],
      events: [modelMessage({ id: 'model-first', text: 'first', toolCallId: 'tool-reused' }), firstApproval],
      requiredActions: [firstApproval],
    });
    const firstContinuation = turn({
      id: 'turn-first-approval',
      input: [
        {
          type: 'user.tool_approval',
          threadId: rootThreadId,
          toolCallId: 'tool-reused',
          approval: { status: 'allow' },
        },
      ],
      events: [modelMessage({ id: 'model-first-approval', text: 'approved' })],
    });
    const secondApproval = approval({
      id: 'approval-second',
      toolCallId: 'tool-reused',
      sourceEventId: 'model-second',
    });
    const secondTurn = turn({
      id: 'turn-second',
      input: [{ type: 'user.message', content: 'second invocation' }],
      events: [modelMessage({ id: 'model-second', text: 'second', toolCallId: 'tool-reused' }), secondApproval],
      requiredActions: [secondApproval],
    });

    const result = await convertTurnsToThreadMessages(
      serverForTurns([secondTurn, firstContinuation, firstTurn]),
      sessionId,
    );
    const assistants = result.messages.filter(message => message.role === 'assistant');
    expect(assistants).toHaveLength(2);
    const firstTool = assistants[0]?.content.find(part => part.type === 'tool-call');
    const secondTool = assistants[1]?.content.find(part => part.type === 'tool-call');
    expect(firstTool?.type).toBe('tool-call');
    expect(secondTool?.type).toBe('tool-call');
    expect(firstTool?.toolCallId).not.toBe(secondTool?.toolCallId);
    expect(firstTool?.approval).toMatchObject({ id: 'tool-reused', approved: true });
    expect(secondTool?.approval).toMatchObject({ id: 'tool-reused' });
    expect(secondTool?.approval).not.toHaveProperty('approved');
  });

  it('sends the raw tool call id when continuing a scoped approval', () => {
    const message: ThreadMessage = {
      id: 'turn-second-assistant',
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId: 'turn-second:tool-reused',
          toolName: 'run_shell',
          args: {},
          argsText: '{}',
          approval: { id: 'tool-reused', approved: true },
        },
      ],
      status: { type: 'requires-action', reason: 'tool-calls' },
      createdAt: new Date('2026-09-05T00:00:00.000Z'),
      metadata: {
        unstable_state: null,
        unstable_annotations: [],
        unstable_data: [],
        steps: [],
        custom: {},
      },
    };

    expect(collectApprovalInputs(message, rootThreadId)).toEqual([
      {
        type: 'user.tool_approval',
        threadId: rootThreadId,
        toolCallId: 'tool-reused',
        approval: { status: 'allow', scope: 'once' },
      },
    ]);
  });

  it('binds same-root continuation results to their model-event invocations', async () => {
    const firstTurn = turn({
      id: 'turn-root',
      input: [{ type: 'user.message', content: 'first invocation' }],
      events: [
        modelMessage({ id: 'model-first', text: 'first', toolCallId: 'tool-reused' }),
        response({ id: 'response-first', toolCallId: 'tool-reused', content: 'first-result' }),
      ],
    });
    const continuation = turn({
      id: 'turn-root-continuation',
      input: [
        {
          type: 'user.tool_approval',
          threadId: rootThreadId,
          toolCallId: 'tool-reused',
          approval: { status: 'allow' },
        },
      ],
      events: [
        modelMessage({ id: 'model-second', text: 'second', toolCallId: 'tool-reused' }),
        response({ id: 'response-second', toolCallId: 'tool-reused', content: 'second-result' }),
      ],
    });

    const result = await convertTurnsToThreadMessages(serverForTurns([firstTurn, continuation]), sessionId);
    const assistant = result.messages.find(message => message.role === 'assistant');
    if (assistant?.role !== 'assistant') throw new Error('expected an assistant message');
    const tools = assistant.content.filter(part => part.type === 'tool-call');
    expect(tools).toHaveLength(2);
    expect(tools[0]?.type).toBe('tool-call');
    expect(tools[1]?.type).toBe('tool-call');
    expect(tools[0]?.toolCallId).toContain('model-first');
    expect(tools[1]?.toolCallId).toContain('model-second');
    expect(tools[0]?.result).toBe('first-result');
    expect(tools[1]?.result).toBe('second-result');
  });

  it('does not attach a reused raw-ID result to an earlier denied invocation', async () => {
    const firstApproval = approval({
      id: 'approval-denied',
      toolCallId: 'tool-reused',
      sourceEventId: 'model-denied',
    });
    const firstTurn = turn({
      id: 'turn-denied',
      input: [{ type: 'user.message', content: 'denied invocation' }],
      events: [modelMessage({ id: 'model-denied', text: 'denied', toolCallId: 'tool-reused' }), firstApproval],
      requiredActions: [firstApproval],
    });
    const continuation = turn({
      id: 'turn-reused',
      input: [
        {
          type: 'user.tool_approval',
          threadId: rootThreadId,
          toolCallId: 'tool-reused',
          approval: { status: 'deny' },
        },
      ],
      events: [
        modelMessage({ id: 'model-reused', text: 'reused', toolCallId: 'tool-reused' }),
        response({ id: 'response-reused', toolCallId: 'tool-reused', content: 'reused-result' }),
      ],
    });

    const result = await convertTurnsToThreadMessages(serverForTurns([firstTurn, continuation]), sessionId);
    const assistant = result.messages.find(message => message.role === 'assistant');
    if (assistant?.role !== 'assistant') throw new Error('expected an assistant message');
    const tools = assistant.content.filter(part => part.type === 'tool-call');
    const deniedTool = tools.find(tool => tool.type === 'tool-call' && tool.toolCallId.includes('model-denied'));
    const reusedTool = tools.find(tool => tool.type === 'tool-call' && tool.toolCallId.includes('model-reused'));
    expect(deniedTool?.approval).toMatchObject({ id: 'tool-reused', approved: false });
    expect(deniedTool?.result).toEqual({ error: 'Tool approval denied' });
    expect(reusedTool?.result).toBe('reused-result');
  });

  it('keeps a late terminal denial on its invocation before matching a reused result', async () => {
    const firstApproval = approval({
      id: 'approval-late',
      toolCallId: 'tool-reused',
      sourceEventId: 'model-late-denied',
    });
    const firstTurn = turn({
      id: 'turn-late-denied',
      input: [{ type: 'user.message', content: 'late denial invocation' }],
      events: [
        modelMessage({ id: 'model-late-denied', text: 'late denied', toolCallId: 'tool-reused' }),
        firstApproval,
      ],
      requiredActions: [firstApproval],
    });
    const continuation = turn({
      id: 'turn-late-reused',
      input: [
        {
          type: 'user.tool_approval',
          threadId: rootThreadId,
          toolCallId: 'tool-reused',
          approval: { status: 'deny' },
        },
      ],
      events: [
        modelMessage({ id: 'model-late-reused', text: 'late reused', toolCallId: 'tool-reused' }),
        {
          type: 'tool.response.v2',
          id: 'response-late-denied',
          threadId: rootThreadId,
          toolCallId: 'tool-reused',
          content: 'denied by server',
          createdAt: '2026-09-05T00:00:02.000Z',
          disposition: 'denied',
          admissionProvenance: {},
        },
        response({ id: 'response-late-reused', toolCallId: 'tool-reused', content: 'late-reused-result' }),
      ],
    });

    const result = await convertTurnsToThreadMessages(serverForTurns([firstTurn, continuation]), sessionId);
    const assistant = result.messages.find(message => message.role === 'assistant');
    if (assistant?.role !== 'assistant') throw new Error('expected an assistant message');
    const tools = assistant.content.filter(part => part.type === 'tool-call');
    const deniedTool = tools.find(tool => tool.type === 'tool-call' && tool.toolCallId.includes('model-late-denied'));
    const reusedTool = tools.find(tool => tool.type === 'tool-call' && tool.toolCallId.includes('model-late-reused'));
    expect(deniedTool?.result).toBe('denied by server');
    expect(reusedTool?.result).toBe('late-reused-result');
  });

  it('keeps nested approval identity scoped to the child model event', async () => {
    const parent = modelMessage({
      id: 'model-parent',
      text: 'parent',
      toolCallId: 'subagent',
      toolName: 'create_sub_agent',
    });
    const childCreated: ThreadCreatedEvent = {
      type: 'thread.created',
      id: 'created-child',
      threadId: 'child-1',
      title: 'Child',
      agentInfo: { name: 'child', input: 'child' },
      parent: { threadId: rootThreadId, toolCallId: 'subagent' },
      createdAt: '2026-09-05T00:00:00.500Z',
    };
    const childApproval = approval({
      id: 'child-approval',
      toolCallId: 'child-tool',
      sourceEventId: 'model-child',
      threadId: 'child-1',
    });
    const result = await convertTurnsToThreadMessages(
      serverForTurns([
        turn({
          id: 'turn-nested',
          input: [{ type: 'user.message', content: 'nested invocation' }],
          events: [
            parent,
            childCreated,
            modelMessage({
              id: 'model-child',
              text: 'child',
              toolCallId: 'child-tool',
              toolName: 'run_shell',
              threadId: 'child-1',
            }),
            childApproval,
          ],
          requiredActions: [childApproval],
        }),
      ]),
      sessionId,
    );
    const assistant = result.messages.find(message => message.role === 'assistant');
    if (assistant?.role !== 'assistant') throw new Error('expected an assistant message');
    const parentTool = assistant.content.find(
      part => part.type === 'tool-call' && part.toolName === 'create_sub_agent',
    );
    if (parentTool?.type !== 'tool-call') throw new Error('expected a sub-agent tool');
    const nested = parentTool.messages?.[0];
    if (nested?.role !== 'assistant') throw new Error('expected a nested assistant message');
    const childTool = nested.content.find(part => part.type === 'tool-call');
    expect(childTool?.type).toBe('tool-call');
    expect(childTool?.toolCallId).toContain('model-child');
    expect(childTool?.approval).toMatchObject({ id: 'child-tool' });
  });

  it('reconstructs a persisted terminal error without an assistant message', async () => {
    const incompleteApproval = approval({
      id: 'approval-incomplete',
      toolCallId: 'tool-incomplete',
      sourceEventId: 'model-incomplete',
    });
    const failedTurn = turn({
      id: 'turn-timeout',
      input: [{ type: 'user.message', content: 'timed out question' }],
      events: [incompleteApproval],
      requiredActions: [incompleteApproval],
      state: {
        status: 'error',
        message: 'Chunk timeout of 60000ms exceeded',
        completedAt: '2026-09-05T00:01:00.000Z',
      },
    });

    const result = await convertTurnsToThreadMessages(serverForTurns([failedTurn]), sessionId);

    expect(result.messages.map(message => message.role)).toEqual(['user']);
    expect(result.messages.some(message => message.status?.type === 'requires-action')).toBe(false);
    expect(result).toMatchObject({
      terminalError: {
        turnId: 'turn-timeout',
        message: 'Chunk timeout of 60000ms exceeded',
      },
    });
  });

  it('keeps a partial assistant answer as the message-owned error surface', async () => {
    const result = await convertTurnsToThreadMessages(
      serverForTurns([
        turn({
          id: 'turn-partial-error',
          input: [{ type: 'user.message', content: 'partial question' }],
          events: [modelMessage({ id: 'model-partial', text: 'partial answer' })],
          state: {
            status: 'error',
            message: 'stream stopped',
            completedAt: '2026-09-05T00:01:00.000Z',
          },
        }),
      ]),
      sessionId,
    );

    const assistants = result.messages.filter(message => message.role === 'assistant');
    expect(assistants).toHaveLength(1);
    expect(assistants[0]?.status).toEqual({ type: 'incomplete', reason: 'error', error: 'stream stopped' });
    expect(result.terminalError).toEqual({ turnId: 'turn-partial-error', message: 'stream stopped' });
  });

  it('preserves cancellation without exposing it as a terminal error', async () => {
    const result = await convertTurnsToThreadMessages(
      serverForTurns([
        turn({
          id: 'turn-cancelled',
          input: [{ type: 'user.message', content: 'cancelled question' }],
          events: [modelMessage({ id: 'model-cancelled', text: 'partial before cancel' })],
          state: {
            status: 'cancelled',
            reason: 'client-cancelled',
            completedAt: '2026-09-05T00:01:00.000Z',
          },
        }),
      ]),
      sessionId,
    );

    const assistant = result.messages.find(message => message.role === 'assistant');
    expect(assistant?.status).toEqual({ type: 'incomplete', reason: 'cancelled' });
    expect(result.terminalError).toBeUndefined();
  });

  it('clears the current terminal error after a newer successful turn', async () => {
    const result = await convertTurnsToThreadMessages(
      serverForTurns([
        turn({
          id: 'turn-failed',
          input: [{ type: 'user.message', content: 'failed question' }],
          events: [],
          state: {
            status: 'error',
            message: 'first failure',
            completedAt: '2026-09-05T00:01:00.000Z',
          },
        }),
        turn({
          id: 'turn-success',
          input: [{ type: 'user.message', content: 'successful question' }],
          events: [modelMessage({ id: 'model-success', text: 'successful answer' })],
        }),
      ]),
      sessionId,
    );

    expect(result.terminalError).toBeUndefined();
    expect(result.messages.map(message => message.role)).toEqual(['user', 'user', 'assistant']);
  });
});

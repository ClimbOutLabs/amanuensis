import { Sessions } from '../../src/agent-session/Sessions';
import { InMemorySessionStore } from '../../src/agent-session/store/InMemorySessionStore';
import { TurnHandle } from '../../src/agent-session/TurnHandle';
import {
  createToolResponseV2,
  EventType,
  ToolExecutionStartedEventSchema,
  type ToolResponseEvent,
  type ToolResponseEventV2,
} from '../../src/core/events/schema';
import type { AgentThreadExecutionEvent, AgentThreadExecutionResult } from '../../src/core/runtime/AgentThread.types';
import { createEmptyAgentThreadMetrics } from '../../src/core/runtime/metrics';
import { makeAgentSpec, makeTestResolver } from './testHelpers';

async function* resultStream(
  event: AgentThreadExecutionEvent | ToolResponseEvent,
): AsyncGenerator<AgentThreadExecutionEvent | ToolResponseEvent, AgentThreadExecutionResult> {
  yield event;
  return { output: null, required_actions: [] };
}

async function persistThroughTurnBoundary(event: ToolResponseEvent | ToolResponseEventV2) {
  const store = new InMemorySessionStore();
  const sessions = new Sessions({ sessionStore: store });
  const session = await sessions.create({
    tenant_id: 'tenant-1',
    session_id: 'session-1',
    created_by_subject: { subject_id: 'user-1', subject_type: 'user', subject_display_name: 'user-1' },
    external_id: null,
    agent: { type: 'inline', spec: makeAgentSpec() },
  });
  const original = await session.createTurn({
    turn_id: 'turn-1',
    input: [{ type: EventType.USER_MESSAGE, content: 'run the tool' }],
    previous_turn_id: 'none',
    signal: new AbortController().signal,
    resolver: makeTestResolver(),
  });
  const record = await store.getTurn({ session_id: session.session_id, turn_id: original.id });
  if (record === undefined) throw new Error('Expected running turn record');

  const handle = new TurnHandle({
    store,
    turn: record,
    orchestrator: {
      execute: () => resultStream(event),
      getMetrics: createEmptyAgentThreadMetrics,
      getLastCallInputTokens: () => null,
    },
    resolver: makeTestResolver(),
    signal: new AbortController().signal,
  });
  for await (const streamed of handle.stream()) void streamed;
  return handle.listEvents({ limit: 20 });
}

describe('TurnHandle tool response persistence boundary', () => {
  it('continues to persist a historical legacy tool.response event', async () => {
    const event: ToolResponseEvent = {
      type: EventType.TOOL_RESPONSE,
      id: 'legacy-result',
      thread_id: 'main',
      tool_call_id: 'legacy-call',
      created_at: new Date().toISOString(),
      content: 'legacy result',
    };

    const { data } = await persistThroughTurnBoundary(event);
    expect(data.filter(item => item.type === EventType.TOOL_RESPONSE)).toEqual([event]);
  });

  it('persists exactly one canonical denied v2 terminal result', async () => {
    const event = createToolResponseV2({
      id: 'denied-result',
      thread_id: 'main',
      tool_call_id: 'denied-call',
      created_at: new Date().toISOString(),
      raw_content: JSON.stringify({ error: 'Denied by user' }),
      model_content: null,
      screen: null,
      disposition: 'denied',
      remediation: undefined,
      admission_provenance: { source: 'user_approval', decision: 'deny' },
      memoized: false,
      repeat_count: 1,
    }).event;

    const { data } = await persistThroughTurnBoundary(event);
    const terminalResults = data.filter(
      item => item.type === EventType.TOOL_RESPONSE || item.type === EventType.TOOL_RESPONSE_V2,
    );
    expect(terminalResults).toEqual([event]);
  });

  it('persists registered-command start before extending the turn deadline', async () => {
    const store = new InMemorySessionStore();
    const sessions = new Sessions({ sessionStore: store });
    const session = await sessions.create({
      tenant_id: 'tenant-1',
      session_id: 'session-command',
      created_by_subject: { subject_id: 'user-1', subject_type: 'user', subject_display_name: 'user-1' },
      external_id: null,
      agent: { type: 'inline', spec: makeAgentSpec() },
    });
    const original = await session.createTurn({
      turn_id: 'turn-command',
      input: [{ type: EventType.USER_MESSAGE, content: 'run verification' }],
      previous_turn_id: 'none',
      signal: new AbortController().signal,
      resolver: makeTestResolver(),
    });
    const record = await store.getTurn({ session_id: session.session_id, turn_id: original.id });
    if (record === undefined) throw new Error('Expected running turn record');

    const started = ToolExecutionStartedEventSchema.parse({
      type: EventType.TOOL_EXECUTION_STARTED,
      id: 'command-started',
      thread_id: 'main',
      tool_call_id: 'command-call',
      tool_name: 'sandbox__run_registered_command',
      created_at: '2026-08-31T12:00:00.000Z',
      command_execution: {
        repository_id: 'repo-1',
        repository_revision: 4,
        command_id: 'verify',
        command: 'pnpm verify',
        cwd: '/workspace/repo',
        timeout_ms: 900_000,
      },
    });
    const terminal = createToolResponseV2({
      id: 'command-result',
      thread_id: 'main',
      tool_call_id: 'command-call',
      created_at: '2026-08-31T12:10:00.000Z',
      raw_content: JSON.stringify({ exit_code: 0 }),
      model_content: null,
      screen: null,
      disposition: 'executed_ok',
      remediation: undefined,
      admission_provenance: { source: 'user_approval', decision: 'allow', scope: 'once' },
      memoized: false,
      repeat_count: 0,
    }).event;
    async function* events(): AsyncGenerator<AgentThreadExecutionEvent, AgentThreadExecutionResult> {
      yield started;
      yield terminal;
      return { output: null, required_actions: [] };
    }

    const order: string[] = [];
    const appendStarted = store.appendCommandExecutionStarted.bind(store);
    jest.spyOn(store, 'appendCommandExecutionStarted').mockImplementation(async input => {
      await appendStarted(input);
      order.push('persisted');
    });
    const handle = new TurnHandle({
      store,
      turn: record,
      orchestrator: {
        execute: events,
        getMetrics: createEmptyAgentThreadMetrics,
        getLastCallInputTokens: () => null,
      },
      resolver: makeTestResolver(),
      signal: new AbortController().signal,
      onCommandExecutionStarted: () => order.push('deadline-extended'),
    });

    for await (const event of handle.stream()) void event;

    expect(order).toEqual(['persisted', 'deadline-extended']);
    await expect(
      store.getCommandExecution({
        session_id: session.session_id,
        turn_id: original.id,
        thread_id: 'main',
        tool_call_id: 'command-call',
      }),
    ).resolves.toMatchObject({ status: 'terminal', disposition: 'executed_ok' });
  });
});

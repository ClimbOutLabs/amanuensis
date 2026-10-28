import type { ILLM } from '../../../src/core/llm/ILLM';
import { AgentThread, ITERATION_LIMIT_MESSAGE } from '../../../src/core/runtime/AgentThread';
import type {
  AgentParent,
  AgentThreadEvent,
  InternalThreadDoneEvent,
} from '../../../src/core/runtime/AgentThread.types';
import { InternalEventType } from '../../../src/core/runtime/AgentThread.types';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { finalAnswerStream, makeSilentLogger } from '../harnessMocks';

/**
 * The step-limit stop speaks to two audiences. The person reads a plain sentence about what
 * happened and what to do next. A sub-agent's parent model reads the original instruction,
 * which names the limit it hit, so the parent's next step is unchanged.
 */
const PERSON_WORDING =
  'This reply stopped because it took too many steps. Nothing further was done. Ask again, or split your request into smaller parts.';

function makeThread(parent: AgentParent | undefined): { thread: AgentThread; create: jest.Mock } {
  const create = jest.fn<ReturnType<ILLM['create']>, Parameters<ILLM['create']>>(() => finalAnswerStream());
  const modelClient: ILLM = { create, createNonStream: jest.fn() };
  const thread = new AgentThread({
    threadId: parent === undefined ? 'main' : 'sub-1',
    title: 'Main',
    parent,
    toolCallMemo: undefined,
    turnToolCallLedger: undefined,
    taskState: undefined,
    isRequestContinuation: undefined,
    tracing: NOOP_AGENT_TRACING,
    logger: makeSilentLogger(),
    definition: {
      modelClient,
      modelId: undefined,
      configuredModels: undefined,
      instruction: 'test',
      iterationLimit: 0,
    },
    context: [{ role: 'user', content: 'Do the thing' }],
  });
  return { thread, create };
}

async function drainEvents(thread: AgentThread): Promise<AgentThreadEvent[]> {
  const events: AgentThreadEvent[] = [];
  for await (const event of thread.execute({ signal: new AbortController().signal })) {
    events.push(event);
  }
  return events;
}

function expectErrorDone(events: readonly AgentThreadEvent[]): InternalThreadDoneEvent & { status: 'error' } {
  const done = events.find((event): event is InternalThreadDoneEvent => event.type === InternalEventType.AGENT_DONE);
  if (done?.status !== 'error') {
    throw new Error(`Expected an error done event, got status ${String(done?.status)}`);
  }
  return done;
}

describe('iteration limit wording', () => {
  it('shows the person a plain stop message when the main thread reaches the limit', async () => {
    const { thread, create } = makeThread(undefined);
    const events = await drainEvents(thread);

    expect(create).not.toHaveBeenCalled();
    const done = expectErrorDone(events);
    expect(done.handoff_cause).toBe('iteration_limit');
    expect(done.error).toBe(PERSON_WORDING);
    expect(done.error).toBe(ITERATION_LIMIT_MESSAGE);
    expect(done.send_to_parent).toBeUndefined();
    expect(events[events.length - 1]).toBe(done);
  });

  it('keeps the original instruction for the parent model when a sub-agent reaches the limit', async () => {
    const { thread, create } = makeThread({ thread_id: 'main', tool_call_id: 'spawn-1' });
    const events = await drainEvents(thread);

    expect(create).not.toHaveBeenCalled();
    const done = expectErrorDone(events);
    expect(done.handoff_cause).toBe('iteration_limit');
    expect(done.error).toBe(PERSON_WORDING);
    expect(done.send_to_parent).toEqual({
      role: 'tool',
      tool_call_id: 'spawn-1',
      content: 'You have reached iteration limit of 0, please request again',
    });
  });
});

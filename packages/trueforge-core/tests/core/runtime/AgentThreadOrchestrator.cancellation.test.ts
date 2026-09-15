import type { AgentCapability } from '../../../src/core/capabilities/AgentCapability';
import { dynamicSubAgents } from '../../../src/core/capabilities/builtins/DynamicSubAgents';
import { EventType } from '../../../src/core/events/schema';
import type { ILLM } from '../../../src/core/llm/ILLM';
import type { ExtendedChatCompletionChunk, RawAssistantMessageWithUsage } from '../../../src/core/llm/LLMTypes';
import { getEmptyUsage } from '../../../src/core/llm/LLMTypes';
import { AgentThread } from '../../../src/core/runtime/AgentThread';
import { InternalEventType, type AgentThreadExecutionEvent } from '../../../src/core/runtime/AgentThread.types';
import { AgentThreadOrchestrator } from '../../../src/core/runtime/AgentThreadOrchestrator';
import type { CreateDynamicSubAgentThread } from '../../../src/core/runtime/CreateDynamicSubAgentThread';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { withTimeout } from '../../../src/core/util/promiseUtils';
import { makeMockILLM, makeSilentLogger } from '../harnessMocks';

async function* createSubAgentStream(
  toolName: string,
): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  const call = {
    id: 'spawn-child',
    type: 'function',
    function: {
      name: toolName,
      arguments: JSON.stringify({ name: 'child', input: 'Inspect cancellation fencing.' }),
    },
  } satisfies NonNullable<RawAssistantMessageWithUsage['output']['tool_calls']>[number];
  yield {
    id: 'spawn-child-chunk',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test-model',
    choices: [
      {
        index: 0,
        delta: { role: 'assistant', tool_calls: [{ index: 0, ...call }] },
        finish_reason: null,
      },
    ],
  };
  return {
    output: { role: 'assistant', content: null, tool_calls: [call] },
    usage: getEmptyUsage(),
    finish_reason: 'tool_calls',
  };
}

async function* createFinalAnswerStream(): AsyncGenerator<
  ExtendedChatCompletionChunk,
  RawAssistantMessageWithUsage,
  unknown
> {
  yield {
    id: 'final-answer-chunk',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test-model',
    choices: [{ index: 0, delta: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
  };
  return {
    output: { role: 'assistant', content: 'done' },
    usage: getEmptyUsage(),
    finish_reason: 'stop',
  };
}

describe('AgentThreadOrchestrator dynamic child cancellation', () => {
  it('does not emit or insert a child completed after cancellation', async () => {
    const model: ILLM = {
      create: jest.fn(body => {
        let toolName: string | undefined;
        for (const candidate of body.tools ?? []) {
          if ('function' in candidate && candidate.function.name.includes('create_sub_agent')) {
            toolName = candidate.function.name;
            break;
          }
        }
        if (toolName === undefined) {
          throw new Error('dynamic sub-agent tool was not exposed');
        }
        return createSubAgentStream(toolName);
      }),
      createNonStream: jest.fn(),
    };
    const capabilities: AgentCapability[] = [
      dynamicSubAgents({ sandboxAvailable: false, tracing: NOOP_AGENT_TRACING }),
    ];
    const root = new AgentThread({
      threadId: 'main',
      title: 'Main',
      definition: { modelId: undefined, configuredModels: undefined, modelClient: model },
      context: [{ role: 'user', content: 'Delegate this task.' }],
      capabilities,
      toolCallMemo: undefined,
      isRequestContinuation: undefined,
      tracing: NOOP_AGENT_TRACING,
      logger: makeSilentLogger(),
    });
    const agentThreads = new Map<string, AgentThread>([['main', root]]);
    const constructionStarted = Promise.withResolvers<AbortSignal>();
    const releaseConstruction = Promise.withResolvers<void>();
    const createDynamicSubAgentThread: CreateDynamicSubAgentThread = async input => {
      constructionStarted.resolve(input.signal);
      await releaseConstruction.promise;
      return new AgentThread({
        threadId: input.threadId,
        title: input.request.name,
        definition: { modelId: undefined, configuredModels: undefined, modelClient: makeMockILLM() },
        parent: input.parent,
        agentInfo: input.request,
        toolCallMemo: undefined,
        isRequestContinuation: undefined,
        tracing: NOOP_AGENT_TRACING,
        logger: makeSilentLogger(),
      });
    };
    const orchestrator = new AgentThreadOrchestrator({
      agentThreads,
      createDynamicSubAgentThread,
      tracing: NOOP_AGENT_TRACING,
      logger: makeSilentLogger(),
    });
    const controller = new AbortController();
    const events: AgentThreadExecutionEvent[] = [];

    const execution = (async (): Promise<void> => {
      for await (const event of orchestrator.execute({ signal: controller.signal })) {
        events.push(event);
      }
    })();
    expect(await withTimeout(constructionStarted.promise, 500, 'dynamic child construction')).toBe(controller.signal);
    controller.abort(new Error('cancel dynamic child construction'));
    releaseConstruction.resolve();

    await expect(withTimeout(execution, 500, 'dynamic child cancellation fence')).rejects.toThrow(
      'cancel dynamic child construction',
    );
    expect(events.some(event => event.type === EventType.THREAD_CREATED)).toBe(false);
    expect([...agentThreads.keys()]).toEqual(['main']);
  });

  it('completes a signal-less send and execution without cleanup dereferencing an absent signal', async () => {
    const model = makeMockILLM({
      create: jest.fn(() => createFinalAnswerStream()),
    });
    const root = new AgentThread({
      threadId: 'main',
      title: 'Main',
      definition: { modelId: undefined, configuredModels: undefined, modelClient: model },
      context: [{ role: 'user', content: 'Answer without a cancellation signal.' }],
      capabilities: [],
      toolCallMemo: undefined,
      isRequestContinuation: undefined,
      tracing: NOOP_AGENT_TRACING,
      logger: makeSilentLogger(),
    });
    const agentThreads = new Map<string, AgentThread>([['main', root]]);
    const orchestrator = new AgentThreadOrchestrator({
      agentThreads,
      createDynamicSubAgentThread: jest.fn(),
      tracing: NOOP_AGENT_TRACING,
      logger: makeSilentLogger(),
    });

    const events: AgentThreadExecutionEvent[] = [];
    for await (const event of orchestrator.execute({})) {
      events.push(event);
    }

    expect(events.at(-1)?.type).toBe(InternalEventType.AGENT_DONE);
    expect(model.create).toHaveBeenCalledTimes(1);
  });
});

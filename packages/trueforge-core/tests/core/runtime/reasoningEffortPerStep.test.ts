import type { ILLM } from '../../../src/core/llm/ILLM';
import type { ExtendedChatCompletionChunk, RawAssistantMessageWithUsage } from '../../../src/core/llm/LLMTypes';
import { getEmptyUsage } from '../../../src/core/llm/LLMTypes';
import {
  CAPPED_STEP_REASONING_ALLOWANCE_TOKENS,
  FINAL_ANSWER_OUTPUT_TOKENS,
} from '../../../src/core/llm/reasoningEffortPolicy';
import type { ModelParams } from '../../../src/core/runtime/AgentDefinition';
import { AgentThread } from '../../../src/core/runtime/AgentThread';
import type { AgentThreadEvent, ContextMessage } from '../../../src/core/runtime/AgentThread.types';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { makeSilentLogger } from '../harnessMocks';

// eslint-disable-next-line @typescript-eslint/require-await -- async generator fixture, not awaiting I/O
async function* answerStream(): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  yield {
    id: 'chunk-1',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test-model',
    choices: [{ index: 0, delta: { role: 'assistant', content: 'answer' }, finish_reason: 'stop' }],
  };
  return {
    output: { role: 'assistant', content: 'answer' },
    usage: getEmptyUsage(),
    finish_reason: 'stop',
  };
}

function makeThread({
  context,
  modelParams,
  reasoningEfforts,
}: {
  context?: ContextMessage[];
  modelParams?: ModelParams;
  reasoningEfforts: readonly string[] | undefined;
}) {
  const create = jest.fn(answerStream);
  const modelClient: ILLM = { create, createNonStream: jest.fn() };
  const thread = new AgentThread({
    threadId: 'main',
    title: 'Main',
    toolCallMemo: undefined,
    taskState: undefined,
    isRequestContinuation: undefined,
    tracing: NOOP_AGENT_TRACING,
    logger: makeSilentLogger(),
    definition: {
      modelClient,
      modelId: undefined,
      configuredModels: undefined,
      instruction: 'test',
      toolSets: [],
      modelProperties: { contextLength: undefined, reasoningEfforts },
      modelParams,
    },
    context: context ?? [{ role: 'user', content: 'A question.' }],
    capabilities: [],
  });
  return { thread, create };
}

/** The request body of the first model call. */
function firstRequest(create: jest.Mock): Record<string, unknown> {
  const [body] = create.mock.calls[0] as [Record<string, unknown>];
  return body;
}

async function drain(thread: AgentThread): Promise<AgentThreadEvent[]> {
  const events: AgentThreadEvent[] = [];
  for await (const event of thread.execute({ signal: new AbortController().signal })) {
    events.push(event);
  }
  return events;
}

describe('per-step reasoning effort and output cap', () => {
  const supported = ['none', 'low', 'medium', 'high'];

  it('sends high on the first step of a reply in automatic mode, with no mode key', async () => {
    const { thread, create } = makeThread({
      modelParams: { reasoning_effort: 'low', reasoning_effort_mode: 'automatic' },
      reasoningEfforts: supported,
    });
    await drain(thread);

    const body = firstRequest(create);
    expect(body['reasoning_effort']).toBe('high');
    expect(body).not.toHaveProperty('reasoning_effort_mode');
  });

  it('sends no effort parameter for a model that advertises no efforts', async () => {
    const { thread, create } = makeThread({
      modelParams: { reasoning_effort: 'high' },
      reasoningEfforts: undefined,
    });
    await drain(thread);

    expect(firstRequest(create)).not.toHaveProperty('reasoning_effort');
  });

  it('fixed mode sends the stored effort, moved onto a supported level', async () => {
    const { thread, create } = makeThread({
      modelParams: { reasoning_effort: 'xhigh', reasoning_effort_mode: 'fixed' },
      reasoningEfforts: ['low', 'medium'],
    });
    await drain(thread);

    expect(firstRequest(create)['reasoning_effort']).toBe('medium');
  });

  it('a final-answer step after tool results sends medium and caps the output at the prose limit', async () => {
    const { thread, create } = makeThread({
      context: [
        { role: 'user', content: 'Look it up.' },
        { role: 'tool', tool_call_id: 'call-1', content: 'result' },
      ],
      modelParams: { reasoning_effort: 'high', max_tokens: 16_000 },
      reasoningEfforts: supported,
    });
    await drain(thread);

    const body = firstRequest(create);
    expect(body['reasoning_effort']).toBe('medium');
    expect(body['max_tokens']).toBe(FINAL_ANSWER_OUTPUT_TOKENS + CAPPED_STEP_REASONING_ALLOWANCE_TOKENS);
  });

  it('records each request under the effort it was sent with', async () => {
    const { thread } = makeThread({ reasoningEfforts: supported });
    await drain(thread);

    expect(thread.getAgentThreadMetrics().step_reasoning_efforts).toEqual({ high: 1 });
  });

  it('records the unset key when no effort parameter is sent', async () => {
    const { thread } = makeThread({ reasoningEfforts: undefined });
    await drain(thread);

    expect(thread.getAgentThreadMetrics().step_reasoning_efforts).toEqual({ unset: 1 });
  });
});

import type { ChatCompletionMessageParam } from 'openai/resources/chat';
import { EventType } from '../../../src/core/events/schema';
import type { ILLM, LLMCreateParamsStreaming } from '../../../src/core/llm/ILLM';
import type { ExtendedChatCompletionChunk, RawAssistantMessageWithUsage } from '../../../src/core/llm/LLMTypes';
import { getEmptyUsage } from '../../../src/core/llm/LLMTypes';
import { AgentThread } from '../../../src/core/runtime/AgentThread';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { makeSilentLogger } from '../harnessMocks';

async function* exhaustedReasoningStream(): AsyncGenerator<
  ExtendedChatCompletionChunk,
  RawAssistantMessageWithUsage,
  unknown
> {
  yield {
    id: 'chunk-length',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test-model',
    choices: [
      {
        index: 0,
        delta: { role: 'assistant', reasoning_content: 'unfinished reasoning' },
        finish_reason: 'length',
      },
    ],
  };
  return {
    output: {
      role: 'assistant',
      content: null,
      reasoning_content: 'unfinished reasoning',
      thinking_blocks: [{ type: 'thinking', thinking: 'unfinished reasoning' }],
    },
    usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30, reasoning_tokens: 20 },
    finish_reason: 'length',
  };
}

async function* finalAnswerStream(): AsyncGenerator<
  ExtendedChatCompletionChunk,
  RawAssistantMessageWithUsage,
  unknown
> {
  yield {
    id: 'chunk-stop',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test-model',
    choices: [{ index: 0, delta: { role: 'assistant', content: 'Recovered.' }, finish_reason: 'stop' }],
  };
  return {
    output: { role: 'assistant', content: 'Recovered.' },
    usage: getEmptyUsage(),
    finish_reason: 'stop',
  };
}

async function* cutOffMidToolCallStream(): AsyncGenerator<
  ExtendedChatCompletionChunk,
  RawAssistantMessageWithUsage,
  unknown
> {
  yield {
    id: 'chunk-cut',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test-model',
    choices: [{ index: 0, delta: { role: 'assistant', content: 'Let me look that up.' }, finish_reason: null }],
  };
  yield {
    id: 'chunk-cut',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test-model',
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: 0,
              id: 'call-cut',
              type: 'function',
              function: { name: 'get_space', arguments: '{"space_id":"sp' },
            },
          ],
        },
        finish_reason: 'length',
      },
    ],
  };
  return {
    output: {
      role: 'assistant',
      content: 'Let me look that up.',
      tool_calls: [{ id: 'call-cut', type: 'function', function: { name: 'get_space', arguments: '{"space_id":"sp' } }],
    },
    usage: getEmptyUsage(),
    finish_reason: 'length',
  };
}

describe('AgentThread token exhaustion recovery', () => {
  it('preserves the failed output but never replays incomplete reasoning', async () => {
    const requests: ChatCompletionMessageParam[][] = [];
    const create = jest
      .fn<ReturnType<ILLM['create']>, Parameters<ILLM['create']>>()
      .mockImplementationOnce((body: LLMCreateParamsStreaming) => {
        requests.push(body.messages);
        return exhaustedReasoningStream();
      })
      .mockImplementationOnce((body: LLMCreateParamsStreaming) => {
        requests.push(body.messages);
        return finalAnswerStream();
      });
    const modelClient: ILLM = { create, createNonStream: jest.fn() };
    const thread = new AgentThread({
      threadId: 'main',
      title: 'Main',
      toolCallMemo: undefined,
      turnToolCallLedger: undefined,
      taskState: undefined,
      isRequestContinuation: undefined,
      tracing: NOOP_AGENT_TRACING,
      logger: makeSilentLogger(),
      definition: { modelClient, modelId: undefined, configuredModels: undefined, instruction: 'test', toolSets: [] },
      context: [
        { role: 'user', content: 'Earlier question' },
        {
          role: 'assistant',
          content: null,
          reasoning_content: 'legacy unfinished reasoning',
          thinking_blocks: [{ type: 'thinking', thinking: 'legacy unfinished reasoning' }],
        },
        { role: 'user', content: 'Current question' },
      ],
    });

    const firstEvents = [];
    for await (const event of thread.execute()) {
      firstEvents.push(event);
    }

    expect(firstEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'internal.agent.context.append',
          context: [],
          output: expect.arrayContaining([expect.objectContaining({ type: 'model.message', finish_reason: 'length' })]),
        }),
        expect.objectContaining({
          type: 'internal.agent.done',
          status: 'error',
          error: "Aman's reply was cut off because it ran long. Ask it to continue.",
        }),
      ]),
    );
    expect(thread.getAgentThreadMetrics()).toEqual(
      expect.objectContaining({ total_input_tokens: 10, total_output_tokens: 20, total_reasoning_tokens: 20 }),
    );
    expect(thread.toSnapshot().context).toHaveLength(3);
    expect(thread.toSnapshot().current_context_usage).toEqual({ prompt_tokens: 10, completion_tokens: 0 });

    for await (const _event of thread.send([{ type: EventType.USER_MESSAGE, content: 'Please answer directly.' }])) {
      // Drain the durable append before the next execution.
    }
    for await (const _event of thread.execute()) {
      // Drain the recovery turn.
    }

    for (const messages of requests) {
      expect(messages).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: 'assistant', reasoning_content: expect.any(String), content: null }),
        ]),
      );
    }
    expect(thread.toSnapshot().context.at(-1)).toEqual(
      expect.objectContaining({ role: 'assistant', content: 'Recovered.' }),
    );
  });

  it('keeps the text of a reply cut off mid tool call but saves no half-written call', async () => {
    const create = jest
      .fn<ReturnType<ILLM['create']>, Parameters<ILLM['create']>>()
      .mockImplementationOnce(() => cutOffMidToolCallStream());
    const modelClient: ILLM = { create, createNonStream: jest.fn() };
    const thread = new AgentThread({
      threadId: 'main',
      title: 'Main',
      toolCallMemo: undefined,
      turnToolCallLedger: undefined,
      taskState: undefined,
      isRequestContinuation: undefined,
      tracing: NOOP_AGENT_TRACING,
      logger: makeSilentLogger(),
      definition: { modelClient, modelId: undefined, configuredModels: undefined, instruction: 'test', toolSets: [] },
      context: [{ role: 'user', content: 'Find my space' }],
    });

    const events = [];
    for await (const event of thread.execute()) {
      events.push(event);
    }

    const append = events.find(event => event.type === 'internal.agent.context.append');
    expect(append).toEqual(
      expect.objectContaining({
        context: [],
        output: [
          expect.objectContaining({
            type: 'model.message',
            finish_reason: 'length',
            content: 'Let me look that up.',
          }),
        ],
      }),
    );
    expect(JSON.stringify(append)).not.toContain('call-cut');
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'internal.agent.done',
          status: 'error',
          error: "Aman's reply was cut off because it ran long. Ask it to continue.",
        }),
      ]),
    );
  });
});

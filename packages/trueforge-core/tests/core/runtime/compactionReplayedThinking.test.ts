import {
  CONVERSATION_COMPACTION_TEMPLATE,
  contextCompaction,
} from '../../../src/core/capabilities/builtins/ContextCompaction';
import type { ILLM, LLMCreateParamsStreaming } from '../../../src/core/llm/ILLM';
import type { ExtendedChatCompletionChunk, RawAssistantMessageWithUsage } from '../../../src/core/llm/LLMTypes';
import { getEmptyUsage } from '../../../src/core/llm/LLMTypes';
import { ModelStreamFault } from '../../../src/core/llm/VercelAILLM';
import { AgentThread } from '../../../src/core/runtime/AgentThread';
import type { ContextMessage, InternalThreadDoneEvent } from '../../../src/core/runtime/AgentThread.types';
import { InternalEventType } from '../../../src/core/runtime/AgentThread.types';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { makeSilentLogger } from '../harnessMocks';

const CONTEXT_LENGTH = 131_072;
const MAX_OUTPUT_TOKENS = 32_000;
// Characters the provider is taken to count per token, matching the host's own estimate.
const CHARS_PER_TOKEN = 4;

/** Characters of everything a request sends back as text, thinking included. */
function sentChars(body: LLMCreateParamsStreaming): number {
  let total = 0;
  for (const message of body.messages) {
    total += typeof message.content === 'string' ? message.content.length : JSON.stringify(message.content).length;
    const thinking: unknown = Reflect.get(message, 'thinking_blocks');
    if (Array.isArray(thinking)) {
      total += JSON.stringify(thinking).length;
    }
  }
  return total;
}

// eslint-disable-next-line @typescript-eslint/require-await -- async generator fixture, not awaiting I/O
async function* overLimitStream(): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  throw new ModelStreamFault(
    "This model's maximum context length is 131072 tokens. However, you requested 32000 output tokens.",
  );
}

// eslint-disable-next-line @typescript-eslint/require-await -- async generator fixture, not awaiting I/O
async function* answerStream(): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  yield {
    id: 'chunk-1',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test-model',
    choices: [{ index: 0, delta: { role: 'assistant', content: 'answer' }, finish_reason: 'stop' }],
  };
  return { output: { role: 'assistant', content: 'answer' }, usage: getEmptyUsage(), finish_reason: 'stop' };
}

/** Runs one turn against a provider that counts what is sent and refuses anything over its window. */
async function runTurn(context: ContextMessage[]): Promise<{
  requests: LLMCreateParamsStreaming[];
  done: InternalThreadDoneEvent | undefined;
}> {
  const requests: LLMCreateParamsStreaming[] = [];
  const create = jest.fn((body: LLMCreateParamsStreaming) => {
    requests.push(body);
    return fitsWindow(body) ? answerStream() : overLimitStream();
  });
  const modelClient: ILLM = {
    create,
    createNonStream: jest.fn().mockResolvedValue({
      output: { role: 'assistant', content: CONVERSATION_COMPACTION_TEMPLATE },
      usage: getEmptyUsage(),
      finish_reason: 'stop',
    }),
  };
  const definition = {
    modelClient,
    modelId: undefined,
    configuredModels: undefined,
    instruction: 'test',
    toolSets: [],
    modelProperties: { contextLength: CONTEXT_LENGTH },
    modelParams: { max_tokens: MAX_OUTPUT_TOKENS },
  };
  const thread = new AgentThread({
    threadId: 'main',
    title: 'Main',
    toolCallMemo: undefined,
    turnToolCallLedger: undefined,
    taskState: undefined,
    isRequestContinuation: undefined,
    tracing: NOOP_AGENT_TRACING,
    logger: makeSilentLogger(),
    definition,
    context,
    currentContextUsage: { prompt_tokens: 99_073, completion_tokens: 0 },
    capabilities: [contextCompaction({ logger: undefined, definition })],
  });
  let done: InternalThreadDoneEvent | undefined;
  for await (const event of thread.execute({ signal: new AbortController().signal })) {
    if (event.type === InternalEventType.AGENT_DONE) {
      done = event;
    }
  }
  return { requests, done };
}

function fitsWindow(body: LLMCreateParamsStreaming): boolean {
  return sentChars(body) / CHARS_PER_TOKEN + MAX_OUTPUT_TOKENS < CONTEXT_LENGTH;
}

describe('compaction with a thinking model', () => {
  it('stops sending earlier thinking, so a long chat that was mostly thinking still answers', async () => {
    // A long chat with a thinking model: each reply is short, but the thinking behind it is
    // fifteen times longer.
    const context: ContextMessage[] = [];
    for (let index = 0; index < 40; index++) {
      context.push({ role: 'user', content: `Question ${String(index)}. ${'q'.repeat(400)}` });
      context.push({
        role: 'assistant',
        content: `Answer ${String(index)}. ${'a'.repeat(800)}`,
        thinking_blocks: [{ type: 'thinking', thinking: 't'.repeat(12_000) }],
      });
    }
    context.push({ role: 'user', content: 'The latest question.' });

    const { requests, done } = await runTurn(context);

    expect(done?.status).toBe('done');
    expect(requests).toHaveLength(1);
    const [request] = requests;
    if (request === undefined) {
      throw new Error('Expected one model request');
    }
    expect(fitsWindow(request)).toBe(true);
    expect(request.messages.some(message => Reflect.get(message, 'thinking_blocks') !== undefined)).toBe(false);
  });

  it("keeps the current reply's thinking and counts it before sending", async () => {
    // A tool-using reply in progress: its thinking must go back with the tool result, and it is
    // larger than the window on its own.
    const context: ContextMessage[] = [
      { role: 'user', content: 'Look this up.' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'lookup', arguments: '{}' },
            tool_info: {
              type: 'mcp',
              mcp_server_id: 'lookup',
              mcp_server_name: 'lookup',
              original_tool_name: 'lookup',
              is_approval_required: false,
              is_client_side: false,
            },
          },
        ],
        thinking_blocks: [{ type: 'thinking', thinking: 't'.repeat(500_000) }],
      },
      { role: 'tool', tool_call_id: 'call-1', content: 'Found it.' },
    ];

    const { requests, done } = await runTurn(context);

    // The size check sees the thinking, so no request the provider would refuse is sent.
    expect(requests.every(fitsWindow)).toBe(true);
    expect(done?.status).toBe('error');
  });
});

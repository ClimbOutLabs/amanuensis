import type { ILLM, LLMCreateParamsStreaming } from '../../../src/core/llm/ILLM';
import type { ExtendedChatCompletionChunk, RawAssistantMessageWithUsage } from '../../../src/core/llm/LLMTypes';
import { getEmptyUsage } from '../../../src/core/llm/LLMTypes';
import { toolResultResponse } from '../../../src/core/mcp/IMCPServer';
import { AgentThread } from '../../../src/core/runtime/AgentThread';
import type { AgentThreadAppendContext } from '../../../src/core/runtime/AgentThread.types';
import { InternalEventType } from '../../../src/core/runtime/AgentThread.types';
import { GROUNDING_NUDGE_MESSAGE } from '../../../src/core/runtime/contextUtils';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { makeMockIMCPServer, makeSilentLogger, OBJECT_INPUT_SCHEMA, unknownToolStream } from '../harnessMocks';

const FRESHNESS_QUESTION = 'What is the latest version of Node.js?';
const ORDINARY_QUESTION = 'What is the capital of France?';

function makeSearchToolSet() {
  const toolSet = makeMockIMCPServer({
    name: 'web',
    preload: true,
    tools: [
      {
        name: 'web_search',
        description: 'Search the web',
        inputSchema: { ...OBJECT_INPUT_SCHEMA, properties: { query: { type: 'string' } }, required: ['query'] },
        preload: true,
      },
    ],
  });
  jest.mocked(toolSet.toolCallInfo).mockResolvedValue({
    type: 'mcp',
    mcp_server_id: toolSet.id,
    mcp_server_name: toolSet.name,
    original_tool_name: 'web_search',
    is_approval_required: false,
  });
  jest.mocked(toolSet.callTool).mockResolvedValue(toolResultResponse({ text: 'search results' }));
  return toolSet;
}

// eslint-disable-next-line @typescript-eslint/require-await -- async generator fixture, not awaiting I/O
async function* finalStream(
  content: string,
): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  yield {
    id: 'final-chunk',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test-model',
    choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }],
  };
  return {
    output: { role: 'assistant', content },
    usage: getEmptyUsage(),
    finish_reason: 'stop',
  };
}

function makeThread(input: { modelClient: ILLM; toolSets: ReturnType<typeof makeSearchToolSet>[]; userText: string }) {
  return new AgentThread({
    threadId: 'main',
    title: 'Main',
    toolCallMemo: undefined,
    isRequestContinuation: undefined,
    tracing: NOOP_AGENT_TRACING,
    logger: makeSilentLogger(),
    definition: {
      modelClient: input.modelClient,
      modelId: undefined,
      configuredModels: undefined,
      instruction: 'test',
      toolSets: input.toolSets,
    },
    context: [{ role: 'user', content: input.userText }],
  });
}

describe('grounding check on a final answer to a freshness question', () => {
  it('nudges once, then accepts the second answer, when no retrieval tool was called this turn', async () => {
    const toolSet = makeSearchToolSet();
    const requests: LLMCreateParamsStreaming[] = [];
    const create = jest.fn((request: LLMCreateParamsStreaming) => {
      requests.push(request);
      return requests.length === 1
        ? finalStream('Node.js 22 is the latest LTS, from memory.')
        : finalStream('I could not search. From memory, Node.js 22 is the latest LTS, marked as such.');
    });
    const modelClient: ILLM = { create, createNonStream: jest.fn() };
    const thread = makeThread({ modelClient, toolSets: [toolSet], userText: FRESHNESS_QUESTION });

    const events: AgentThreadAppendContext[] = [];
    let doneCount = 0;
    for await (const event of thread.execute({ signal: new AbortController().signal })) {
      if (event.type === InternalEventType.AGENT_CONTEXT_APPEND) {
        events.push(event);
      }
      if (event.type === InternalEventType.AGENT_DONE) {
        doneCount += 1;
      }
    }

    expect(create).toHaveBeenCalledTimes(2);
    expect(doneCount).toBe(1);
    expect(JSON.stringify(requests[1]?.messages)).toContain(GROUNDING_NUDGE_MESSAGE);
    const nudgeAppends = events.filter(event => event.grounding_nudge === true);
    expect(nudgeAppends).toHaveLength(1);
  });

  it('does not nudge when a retrieval tool was already called this turn', async () => {
    const toolSet = makeSearchToolSet();
    const requests: LLMCreateParamsStreaming[] = [];
    const create = jest.fn((request: LLMCreateParamsStreaming) => {
      requests.push(request);
      if (requests.length === 1) {
        return unknownToolStream({ toolName: 'web_search', callId: 'search-1' });
      }
      return finalStream('Node.js 22 is the latest LTS, per the search results.');
    });
    const modelClient: ILLM = { create, createNonStream: jest.fn() };
    const thread = makeThread({ modelClient, toolSets: [toolSet], userText: FRESHNESS_QUESTION });

    for await (const _event of thread.execute({ signal: new AbortController().signal })) {
      // drain
    }

    expect(toolSet.callTool).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(requests[1]?.messages)).not.toContain(GROUNDING_NUDGE_MESSAGE);
  });

  it('does not nudge when no retrieval-capable tool is attached', async () => {
    const create = jest.fn(() => finalStream('Node.js 22 is the latest LTS, from memory.'));
    const modelClient: ILLM = { create, createNonStream: jest.fn() };
    const thread = makeThread({ modelClient, toolSets: [], userText: FRESHNESS_QUESTION });

    for await (const _event of thread.execute({ signal: new AbortController().signal })) {
      // drain
    }

    expect(create).toHaveBeenCalledTimes(1);
  });

  it('does not nudge for an ordinary question', async () => {
    const toolSet = makeSearchToolSet();
    const create = jest.fn(() => finalStream('Paris.'));
    const modelClient: ILLM = { create, createNonStream: jest.fn() };
    const thread = makeThread({ modelClient, toolSets: [toolSet], userText: ORDINARY_QUESTION });

    for await (const _event of thread.execute({ signal: new AbortController().signal })) {
      // drain
    }

    expect(create).toHaveBeenCalledTimes(1);
  });
});

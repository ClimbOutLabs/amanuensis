import { EventType } from '../../../src/core/events/schema';
import type { ILLM, LLMCreateParamsStreaming } from '../../../src/core/llm/ILLM';
import type { ExtendedChatCompletionChunk, RawAssistantMessageWithUsage } from '../../../src/core/llm/LLMTypes';
import { getEmptyUsage } from '../../../src/core/llm/LLMTypes';
import { toolResultResponse } from '../../../src/core/mcp/IMCPServer';
import { AgentThread } from '../../../src/core/runtime/AgentThread';
import type { AgentThreadAppendContext, AgentThreadEvent } from '../../../src/core/runtime/AgentThread.types';
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
    turnToolCallLedger: undefined,
    taskState: undefined,
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
    const finals: string[] = [];
    const deltas: string[] = [];
    let doneCount = 0;
    for await (const event of thread.execute({ signal: new AbortController().signal })) {
      if (event.type === InternalEventType.AGENT_CONTEXT_APPEND) {
        events.push(event);
        for (const output of event.output) {
          if (output.type === EventType.MODEL_MESSAGE && typeof output.content === 'string') {
            finals.push(output.content);
          }
        }
      }
      if (event.type === EventType.MODEL_MESSAGE_DELTA && typeof event.content === 'string') {
        deltas.push(event.content);
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
    // The discarded draft is never published: not as a final, not in the live
    // deltas, not in any appended context message, and not in the history the
    // next turn (or compaction, or the summary helper) reads.
    const draft = 'Node.js 22 is the latest LTS, from memory.';
    const accepted = 'I could not search. From memory, Node.js 22 is the latest LTS, marked as such.';
    expect(finals).toEqual([accepted]);
    expect(deltas.join('')).not.toContain(draft);
    expect(deltas.join('')).toContain(accepted);
    expect(JSON.stringify(events.map(event => event.context))).not.toContain(draft);
    expect(JSON.stringify(requests[1]?.messages)).not.toContain(draft);
    const savedContext = JSON.stringify(thread.toSnapshot().context);
    expect(savedContext).not.toContain(draft);
    expect(savedContext).toContain(accepted);
  });

  it('does not nudge when a retrieval tool was already called this turn', async () => {
    const toolSet = makeSearchToolSet();
    const requests: LLMCreateParamsStreaming[] = [];
    const create = jest.fn((request: LLMCreateParamsStreaming) => {
      requests.push(request);
      if (requests.length === 1) {
        return unknownToolStream({
          toolName: 'web_search',
          callId: 'search-1',
          args: JSON.stringify({ query: 'latest Node.js version' }),
        });
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

  it('does not nudge for a dated acknowledgment in the person\u2019s own words', async () => {
    const toolSet = makeSearchToolSet();
    const create = jest.fn(() => finalStream('Noted, the lease is back.'));
    const modelClient: ILLM = { create, createNonStream: jest.fn() };
    const thread = makeThread({
      modelClient,
      toolSets: [toolSet],
      userText: 'The signed lease came back on 12 March 2028.',
    });

    const events: AgentThreadAppendContext[] = [];
    const finals: string[] = [];
    for await (const event of thread.execute({ signal: new AbortController().signal })) {
      if (event.type === InternalEventType.AGENT_CONTEXT_APPEND) {
        events.push(event);
        for (const output of event.output) {
          if (output.type === EventType.MODEL_MESSAGE && typeof output.content === 'string') {
            finals.push(output.content);
          }
        }
      }
    }

    expect(create).toHaveBeenCalledTimes(1);
    expect(events.filter(event => event.grounding_nudge === true)).toHaveLength(0);
    expect(finals).toEqual(['Noted, the lease is back.']);
  });

  it('never exposes a withheld draft when the turn is cancelled while it is streaming', async () => {
    const toolSet = makeSearchToolSet();
    const controller = new AbortController();
    let releaseDraft: () => void = () => undefined;
    const draftGate = new Promise<void>(resolve => {
      releaseDraft = resolve;
    });
    let markDraftStreaming: () => void = () => undefined;
    const draftStreaming = new Promise<void>(resolve => {
      markDraftStreaming = resolve;
    });
    async function* draftStream(): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
      yield {
        id: 'draft-chunk',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'test-model',
        choices: [{ index: 0, delta: { role: 'assistant', content: 'Draft from memory.' }, finish_reason: null }],
      };
      markDraftStreaming();
      await draftGate;
      return {
        output: { role: 'assistant', content: 'Draft from memory.' },
        usage: getEmptyUsage(),
        finish_reason: 'stop',
      };
    }
    const create = jest.fn(() => draftStream());
    const modelClient: ILLM = { create, createNonStream: jest.fn() };
    const thread = makeThread({ modelClient, toolSets: [toolSet], userText: FRESHNESS_QUESTION });

    const appends: AgentThreadAppendContext[] = [];
    const deltas: string[] = [];
    const run = (async () => {
      for await (const event of thread.execute({ signal: controller.signal })) {
        if (event.type === InternalEventType.AGENT_CONTEXT_APPEND) {
          appends.push(event);
        }
        if (event.type === EventType.MODEL_MESSAGE_DELTA && typeof event.content === 'string') {
          deltas.push(event.content);
        }
      }
    })().catch(() => undefined);
    await draftStreaming;
    controller.abort();
    releaseDraft();
    await run;

    expect(JSON.stringify(appends.map(event => event.output))).not.toContain('Draft from memory.');
    expect(JSON.stringify(appends.map(event => event.context))).not.toContain('Draft from memory.');
    expect(deltas.join('')).not.toContain('Draft from memory.');
    expect(JSON.stringify(thread.toSnapshot().context)).not.toContain('Draft from memory.');
  });

  it('keeps the withheld draft out when the retry pauses for approval, then finishes with one final', async () => {
    const toolSet = makeSearchToolSet();
    jest.mocked(toolSet.toolCallInfo).mockResolvedValue({
      type: 'mcp',
      mcp_server_id: toolSet.id,
      mcp_server_name: toolSet.name,
      original_tool_name: 'web_search',
      is_approval_required: true,
    });
    const requests: LLMCreateParamsStreaming[] = [];
    const create = jest.fn((request: LLMCreateParamsStreaming) => {
      requests.push(request);
      if (requests.length === 1) {
        return finalStream('Draft from memory.');
      }
      if (requests.length === 2) {
        return unknownToolStream({
          toolName: 'web_search',
          callId: 'search-1',
          args: JSON.stringify({ query: 'latest Node.js version' }),
        });
      }
      return finalStream('Checked answer.');
    });
    const modelClient: ILLM = { create, createNonStream: jest.fn() };
    const thread = makeThread({ modelClient, toolSets: [toolSet], userText: FRESHNESS_QUESTION });

    const appends: AgentThreadAppendContext[] = [];
    const finals: string[] = [];
    const collect = (event: AgentThreadEvent) => {
      if (event.type === InternalEventType.AGENT_CONTEXT_APPEND) {
        appends.push(event);
        for (const output of event.output) {
          if (output.type === EventType.MODEL_MESSAGE && typeof output.content === 'string') {
            finals.push(output.content);
          }
        }
      }
    };

    const cardIds: string[] = [];
    for await (const event of thread.execute({ signal: new AbortController().signal })) {
      collect(event);
      if (event.type === EventType.TOOL_APPROVAL_REQUIRED) {
        cardIds.push(...event.tool_calls.map(call => call.id));
      }
    }

    // The turn paused for approval on the retry's search. The withheld draft
    // is in no output, no context append, and the search has not run yet.
    expect(cardIds).toEqual(['search-1']);
    expect(thread.isAwaitingUserInput()).toBe(true);
    expect(toolSet.callTool).not.toHaveBeenCalled();
    expect(finals).toEqual([]);
    expect(JSON.stringify(appends.map(event => event.context))).not.toContain('Draft from memory.');

    for await (const event of thread.send([
      {
        type: EventType.USER_TOOL_APPROVAL,
        thread_id: 'main',
        tool_call_id: 'search-1',
        approval: { status: 'allow' },
      },
    ])) {
      void event;
    }
    for await (const event of thread.execute({ signal: new AbortController().signal })) {
      collect(event);
    }

    expect(toolSet.callTool).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(3);
    expect(finals).toEqual(['Checked answer.']);
    expect(JSON.stringify(thread.toSnapshot().context)).not.toContain('Draft from memory.');
  });
});

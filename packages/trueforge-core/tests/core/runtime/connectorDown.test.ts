import { McpConnectionError, McpRedirectRefusedError } from '../../../src/core/errors';
import { EventType } from '../../../src/core/events/schema';
import type { ILLM, LLMCreateParamsStreaming } from '../../../src/core/llm/ILLM';
import type {
  ExtendedChatCompletionChunk,
  InternalToolCallInfo,
  RawAssistantMessageWithUsage,
} from '../../../src/core/llm/LLMTypes';
import { getEmptyUsage } from '../../../src/core/llm/LLMTypes';
import type { IToolSet, ListToolsResponse } from '../../../src/core/mcp/IMCPServer';
import { AgentThread } from '../../../src/core/runtime/AgentThread';
import type { AgentThreadEvent, ContextMessage } from '../../../src/core/runtime/AgentThread.types';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { makeMockIMCPServer, makeSilentLogger } from '../harnessMocks';

const UNREACHABLE_TEXT = 'Email is not reachable right now, so that step did not run. Try again in a minute.';
const SEND_ARGS = { to: 'dana@example.test', subject: 'Hello', body: 'Hi Dana' };

function sendStream(id: string): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  return (async function* () {
    const call = {
      id,
      type: 'function' as const,
      function: { name: 'send_email', arguments: JSON.stringify(SEND_ARGS) },
    };
    yield {
      id: `${id}-chunk`,
      object: 'chat.completion.chunk',
      created: 0,
      model: 'test-model',
      choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, ...call }] }, finish_reason: null }],
    };
    return {
      output: { role: 'assistant', content: null, tool_calls: [call] },
      usage: getEmptyUsage(),
      finish_reason: 'tool_calls',
    };
  })();
}

function textStream(): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  return (async function* () {
    yield {
      id: 'text-chunk',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'test-model',
      choices: [{ index: 0, delta: { role: 'assistant', content: 'I could not send it.' }, finish_reason: null }],
    };
    return {
      output: { role: 'assistant', content: 'I could not send it.' },
      usage: getEmptyUsage(),
      finish_reason: 'stop',
    };
  })();
}

const SEND_CARD: InternalToolCallInfo['tier3_card'] = {
  plain_what: 'Send an email.',
  plain_why: null,
  cannot_be_undone: null,
  why_asked_again: null,
  destination: 'Email',
  recipient: 'dana@example.test',
  amount: null,
  parsed_command: null,
  outbound_text: null,
  destination_host: null,
  outbound_truncated: false,
};

function buildThread({
  toolSet,
  modelClient,
  context,
}: {
  toolSet: IToolSet;
  modelClient: ILLM;
  context: ContextMessage[];
}): AgentThread {
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
      modelClient,
      modelId: undefined,
      configuredModels: undefined,
      instruction: 'test',
      toolSets: [toolSet],
    },
    context,
  });
}

function makeThread({ modelSteps, classifyDown }: { modelSteps: ('send' | 'text')[]; classifyDown: boolean }) {
  const toolSet = makeMockIMCPServer({
    name: 'Email',
    preload: true,
    tools: [{ name: 'send_email', description: 'Send', inputSchema: { type: 'object' }, preload: true }],
  });
  const refusal = new McpConnectionError('connect ECONNREFUSED 192.0.2.1:9557', 502);
  jest.mocked(toolSet.toolCallInfo).mockImplementation((params, resolveUnderlyingTool) => {
    if (classifyDown && resolveUnderlyingTool) {
      return Promise.reject(refusal);
    }
    return Promise.resolve({
      type: 'mcp',
      mcp_server_id: toolSet.id,
      mcp_server_name: toolSet.name,
      original_tool_name: params.name,
      is_approval_required: true,
      tier: 3,
      tier3_card: SEND_CARD,
    });
  });
  const requests: LLMCreateParamsStreaming[] = [];
  const queue = [...modelSteps];
  const modelClient: ILLM = {
    create: jest.fn((body: LLMCreateParamsStreaming) => {
      requests.push(body);
      const next = queue.shift();
      if (next === undefined) {
        throw new Error('the model was called more often than the test expects');
      }
      return next === 'send' ? sendStream(`send-${String(requests.length)}`) : textStream();
    }),
    createNonStream: jest.fn(),
  };
  const thread = buildThread({ toolSet, modelClient, context: [{ role: 'user', content: 'Email Dana.' }] });
  return { thread, toolSet, requests, modelClient };
}

async function run(thread: AgentThread): Promise<AgentThreadEvent[]> {
  const events: AgentThreadEvent[] = [];
  for await (const event of thread.execute({ signal: new AbortController().signal })) {
    events.push(event);
  }
  return events;
}

function cardIds(events: AgentThreadEvent[]): string[] {
  return events.flatMap(event =>
    event.type === EventType.TOOL_APPROVAL_REQUIRED ? event.tool_calls.map(call => call.id) : [],
  );
}

function results(events: AgentThreadEvent[]) {
  return events.flatMap(event => (event.type === EventType.TOOL_RESPONSE_V2 ? [event] : []));
}

function offeredToolNames(request: LLMCreateParamsStreaming | undefined): string[] {
  return (request?.tools ?? []).flatMap(tool => (tool.type === 'function' ? [tool.function.name] : []));
}

describe('a send to a connector that is down', () => {
  it('raises no approval card and answers that the connector is not reachable', async () => {
    const { thread, toolSet } = makeThread({ modelSteps: ['send', 'text'], classifyDown: true });
    const events = await run(thread);

    expect(cardIds(events)).toEqual([]);
    expect(toolSet.callTool).not.toHaveBeenCalled();
    const [result] = results(events);
    expect(JSON.stringify(result?.content)).toContain(UNREACHABLE_TEXT);
  });

  it('does not offer the tool again in the same reply, and refuses a retry without a card', async () => {
    const { thread, requests } = makeThread({ modelSteps: ['send', 'send', 'text'], classifyDown: true });
    const events = await run(thread);

    expect(cardIds(events)).toEqual([]);
    expect(offeredToolNames(requests[0])).toContain('send_email');
    expect(offeredToolNames(requests[1])).not.toContain('send_email');
    expect(results(events).map(result => result.tool_call_id)).toEqual(['send-1', 'send-2']);
  });
});

describe('an approved send whose connector dropped off before it ran', () => {
  it('answers that the connector is not reachable instead of "not found in tool mapping"', async () => {
    const { thread, toolSet, requests, modelClient } = makeThread({
      modelSteps: ['send', 'text'],
      classifyDown: false,
    });
    expect(cardIds(await run(thread))).toEqual(['send-1']);

    // The connector goes down after the card is shown. The app rebuilds the thread from the saved
    // conversation to continue, and the new tool list leaves the connector out.
    for await (const event of thread.send([
      {
        type: EventType.USER_TOOL_APPROVAL,
        thread_id: 'main',
        tool_call_id: 'send-1',
        approval: { status: 'allow', scope: 'once' },
      },
    ])) {
      void event;
    }
    jest
      .mocked(toolSet.listTools)
      .mockImplementation((): Promise<ListToolsResponse> => Promise.reject(new McpConnectionError('down', 502)));
    const resumed = buildThread({ toolSet, modelClient, context: thread.toSnapshot().context });
    const after = await run(resumed);

    expect(toolSet.callTool).not.toHaveBeenCalled();
    const [result] = results(after);
    const text = JSON.stringify(result?.content);
    expect(text).toContain(UNREACHABLE_TEXT);
    expect(text).not.toContain('not found in tool mapping');
    expect(offeredToolNames(requests.at(-1))).not.toContain('send_email');
  });
});

describe('a send to a reachable connector', () => {
  it('still raises its approval card', async () => {
    const { thread } = makeThread({ modelSteps: ['send'], classifyDown: false });
    expect(cardIds(await run(thread))).toEqual(['send-1']);
  });
});

function callToolStream({
  id,
  server,
  tool,
}: {
  id: string;
  server: string;
  tool: string;
}): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  return (async function* () {
    const call = {
      id,
      type: 'function' as const,
      function: { name: 'call_tool', arguments: JSON.stringify({ mcp_server: server, tool_name: tool, input: {} }) },
    };
    yield {
      id: `${id}-chunk`,
      object: 'chat.completion.chunk',
      created: 0,
      model: 'test-model',
      choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, ...call }] }, finish_reason: null }],
    };
    return {
      output: { role: 'assistant', content: null, tool_calls: [call] },
      usage: getEmptyUsage(),
      finish_reason: 'tool_calls',
    };
  })();
}

describe('one down server behind call_tool', () => {
  it('does not block call_tool to a healthy server in the same reply, and names the inner connector', async () => {
    const down = makeMockIMCPServer({
      name: 'Email',
      preload: false,
      tools: [{ name: 'send_email', description: 'Send', inputSchema: { type: 'object' }, preload: false }],
    });
    jest
      .mocked(down.toolCallInfo)
      .mockRejectedValue(new McpConnectionError('connect ECONNREFUSED 192.0.2.1:9557', 502));
    const healthy = makeMockIMCPServer({
      name: 'Calendar',
      preload: false,
      tools: [{ name: 'create_event', description: 'Add', inputSchema: { type: 'object' }, preload: false }],
    });
    jest.mocked(healthy.toolCallInfo).mockImplementation(params =>
      Promise.resolve({
        type: 'mcp',
        mcp_server_id: healthy.id,
        mcp_server_name: healthy.name,
        original_tool_name: params.name,
        is_approval_required: true,
        tier: 3,
        tier3_card: SEND_CARD,
      }),
    );
    const steps = [
      callToolStream({ id: 'call-1', server: 'Email', tool: 'send_email' }),
      callToolStream({ id: 'call-2', server: 'Calendar', tool: 'create_event' }),
    ];
    const requests: LLMCreateParamsStreaming[] = [];
    const modelClient: ILLM = {
      create: jest.fn((body: LLMCreateParamsStreaming) => {
        requests.push(body);
        const next = steps.shift();
        if (next === undefined) {
          throw new Error('the model was called more often than the test expects');
        }
        return next;
      }),
      createNonStream: jest.fn(),
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
      definition: {
        modelClient,
        modelId: undefined,
        configuredModels: undefined,
        instruction: 'test',
        toolSets: [down, healthy],
      },
      context: [{ role: 'user', content: 'Email Dana, then add the event.' }],
    });

    const events = await run(thread);

    const [first] = results(events);
    const firstText = JSON.stringify(first?.content);
    expect(firstText).toContain('Email is not reachable right now, so that step did not run.');
    expect(firstText).not.toContain('deferred-tools');
    expect(offeredToolNames(requests[1])).toContain('call_tool');
    expect(cardIds(events)).toEqual(['call-2']);
  });
});

describe('a server failure that is not a lost connection', () => {
  it('keeps the approval card when the server refused a redirect', async () => {
    const { thread, toolSet } = makeThread({ modelSteps: ['send'], classifyDown: false });
    jest.mocked(toolSet.toolCallInfo).mockImplementation((params, resolveUnderlyingTool) => {
      if (resolveUnderlyingTool) {
        return Promise.reject(
          new McpConnectionError('Failed to connect', 502, { cause: new McpRedirectRefusedError('redirected') }),
        );
      }
      return Promise.resolve({
        type: 'mcp',
        mcp_server_id: toolSet.id,
        mcp_server_name: toolSet.name,
        original_tool_name: params.name,
        is_approval_required: false,
      });
    });
    expect(cardIds(await run(thread))).toEqual(['send-1']);
  });
});

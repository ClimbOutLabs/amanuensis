import { McpConnectionError } from '../../../src/core/errors';
import { EventType } from '../../../src/core/events/schema';
import type { ILLM } from '../../../src/core/llm/ILLM';
import type { ExtendedChatCompletionChunk, RawAssistantMessageWithUsage } from '../../../src/core/llm/LLMTypes';
import { getEmptyUsage } from '../../../src/core/llm/LLMTypes';
import type { IToolSet } from '../../../src/core/mcp/IMCPServer';
import { AgentThread } from '../../../src/core/runtime/AgentThread';
import type { AgentThreadEvent } from '../../../src/core/runtime/AgentThread.types';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { makeMockIMCPServer, makeSilentLogger } from '../harnessMocks';

const TOOL_CALL_ID = 'flaky-call-1';
const CONNECTION_FAILURE_MESSAGE = 'flaky-mcp is unreachable (ECONNREFUSED)';

/**
 * An MCP toolset whose classification call — `toolCallInfo` invoked with
 * `resolveUnderlyingTool: true`, the path enrichAssistantMessage uses once the complete tool
 * call is assembled — always throws, mirroring a server that answered `listTools` at init but
 * has since dropped off the network (a remote server fetching its tool list for annotations, or
 * a deferred tool connecting to the underlying server it wraps). The streaming-delta path
 * (`resolveUnderlyingTool: false`) still resolves normally: that earlier, provisional call is
 * what lets the model's tool call reach enrichment at all.
 */
function makeUnreachableDuringClassificationToolSet(): IToolSet {
  const toolSet = makeMockIMCPServer({ name: 'flaky-mcp', preload: true });
  const connectionFailure = () =>
    new McpConnectionError(CONNECTION_FAILURE_MESSAGE, 502, {
      cause: Object.assign(new Error(CONNECTION_FAILURE_MESSAGE), { code: 'ECONNREFUSED' }),
    });
  jest.mocked(toolSet.toolCallInfo).mockImplementation((_params, resolveUnderlyingTool) => {
    if (resolveUnderlyingTool) {
      return Promise.reject(connectionFailure());
    }
    return Promise.resolve({
      type: 'mcp',
      mcp_server_id: toolSet.id,
      mcp_server_name: toolSet.name,
      original_tool_name: 'tool_a',
      is_approval_required: false,
    });
  });
  return toolSet;
}

async function* toolCallStream(): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  const call = {
    id: TOOL_CALL_ID,
    type: 'function' as const,
    function: { name: 'tool_a', arguments: '{}' },
  };
  yield {
    id: 'chunk-1',
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

async function* finalAnswerStream(
  content: string,
): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  yield {
    id: 'final-chunk',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test-model',
    choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: 'stop' }],
  };
  return {
    output: { role: 'assistant', content },
    usage: getEmptyUsage(),
    finish_reason: 'stop',
  };
}

describe('AgentThread enrichment degrade on an unreachable MCP server', () => {
  it('answers the call as unreachable without a card instead of failing the turn, and completes', async () => {
    const toolSet = makeUnreachableDuringClassificationToolSet();
    const create = jest
      .fn()
      .mockImplementationOnce(() => toolCallStream())
      .mockImplementation(() => finalAnswerStream('Noted the tool failure and stopped there.'));
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
      definition: {
        modelClient,
        modelId: undefined,
        configuredModels: undefined,
        instruction: 'test',
        toolSets: [toolSet],
      },
      context: [{ role: 'user', content: 'call the flaky tool' }],
    });

    const events: AgentThreadEvent[] = [];
    for await (const event of thread.execute({ signal: new AbortController().signal })) {
      events.push(event);
    }

    // The turn is not ended as an error, and nothing was left to approve.
    expect(events.some(event => event.type === 'internal.agent.done' && event.status === 'error')).toBe(false);
    expect(events.map(event => event.type)).not.toContain(EventType.TOOL_APPROVAL_REQUIRED);
    expect(toolSet.callTool).not.toHaveBeenCalled();

    const toolResponseEvent = events.find(
      event => event.type === EventType.TOOL_RESPONSE_V2 && event.tool_call_id === TOOL_CALL_ID,
    );
    if (toolResponseEvent?.type !== EventType.TOOL_RESPONSE_V2) {
      throw new Error('expected a canonical tool.response.v2 event for the call');
    }
    expect(toolResponseEvent.content).toEqual(
      expect.stringContaining('flaky-mcp is not reachable right now, so that step did not run. Try again in a minute.'),
    );
    expect(toolResponseEvent.disposition).toBe('never_ran');
    expect(events.at(-1)).toMatchObject({ status: 'done' });
  });
});

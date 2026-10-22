import { McpConnectionError, ToolPreDispatchError } from '../../../src/core/errors';
import { EventType } from '../../../src/core/events/schema';
import type { ILLM } from '../../../src/core/llm/ILLM';
import type { ExtendedChatCompletionChunk, RawAssistantMessageWithUsage } from '../../../src/core/llm/LLMTypes';
import { getEmptyUsage } from '../../../src/core/llm/LLMTypes';
import type { IToolSet } from '../../../src/core/mcp/IMCPServer';
import { AgentThread } from '../../../src/core/runtime/AgentThread';
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
  const connectionFailure = () => new McpConnectionError(CONNECTION_FAILURE_MESSAGE, 502);
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
  // The approval retries the connection at dispatch. ToolSet wraps a listTools/connect
  // failure as a pre-dispatch failure, proving the underlying tool never ran.
  jest
    .mocked(toolSet.callTool)
    .mockImplementation(() =>
      Promise.reject(
        new ToolPreDispatchError(`Tool 'tool_a' could not be prepared for execution`, { cause: connectionFailure() }),
      ),
    );
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
  it('pauses the call for approval instead of failing the turn, then reports the retried dispatch failure and completes', async () => {
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

    // First turn: the model calls the tool, classification throws mid-enrichment.
    let events = [];
    for await (const event of thread.execute({ signal: new AbortController().signal })) {
      events.push(event);
    }

    // (a) The turn is not ended as an error; it pauses for approval instead.
    expect(events.some(event => event.type === 'internal.agent.done' && event.status === 'error')).toBe(false);
    expect(events.map(event => event.type)).toContain(EventType.TOOL_APPROVAL_REQUIRED);

    const approvalEvent = events.find(event => event.type === EventType.TOOL_APPROVAL_REQUIRED);
    if (approvalEvent?.type !== EventType.TOOL_APPROVAL_REQUIRED) {
      throw new Error('expected a tool.approval_required event');
    }
    const pendingCall = approvalEvent.tool_calls[0];
    if (pendingCall === undefined) {
      throw new Error('expected one pending approval');
    }
    expect(pendingCall.id).toBe(TOOL_CALL_ID);

    // (b) The tool info carried for that call is the fail-closed, approval-gated one this fix
    // synthesizes — never a value the (throwing) server could have actually vouched for.
    const deltasForCall = events.filter(
      event => event.type === EventType.MODEL_MESSAGE_DELTA && event.id === pendingCall.source_event_id,
    );
    const toolInfosForCall = deltasForCall.flatMap(event =>
      event.type === EventType.MODEL_MESSAGE_DELTA ? (event.tool_calls ?? []) : [],
    );
    // The wire ToolInfo carries only the model/approval-facing fields (no internal
    // is_approval_required/is_client_side) — the description is what proves this call was
    // classified fail-closed rather than genuinely vouched for by the (throwing) server.
    expect(toolInfosForCall.map(tc => tc.tool_info)).toContainEqual(
      expect.objectContaining({
        type: 'mcp',
        name: 'tool_a',
        server_id: toolSet.id,
        description: expect.stringContaining(CONNECTION_FAILURE_MESSAGE),
      }),
    );

    // (c) Approve; dispatch retries the same dead connection, callTool throws again, and that
    // lands as an honest tool.response error — not a second turn-level failure.
    for await (const _event of thread.send([
      {
        type: EventType.USER_TOOL_APPROVAL,
        thread_id: 'main',
        tool_call_id: TOOL_CALL_ID,
        approval: { status: 'allow', scope: 'once' },
      },
    ])) {
      // Context updates are consumed by the session layer in production.
    }
    events = [];
    for await (const event of thread.execute()) {
      events.push(event);
    }

    expect(toolSet.callTool).toHaveBeenCalledTimes(1);
    const toolResponseEvent = events.find(
      event => event.type === EventType.TOOL_RESPONSE_V2 && event.tool_call_id === TOOL_CALL_ID,
    );
    if (toolResponseEvent?.type !== EventType.TOOL_RESPONSE_V2) {
      throw new Error('expected a canonical tool.response.v2 event for the retried call');
    }
    expect(toolResponseEvent.content).toEqual(expect.stringContaining('could not be prepared for execution'));
    expect(toolResponseEvent.disposition).toBe('never_ran');
    expect(toolResponseEvent.admission_provenance).toMatchObject({ source: 'user_approval' });
    expect(events.some(event => event.type === 'internal.agent.done' && event.status === 'error')).toBe(false);
    expect(events.at(-1)).toMatchObject({ status: 'done' });
  });
});

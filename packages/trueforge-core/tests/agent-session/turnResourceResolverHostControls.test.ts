/**
 * Host controls configured on a TurnResourceResolver must reach the turn's
 * AgentThread: the tool-call policy (blocks before dispatch) and the model
 * first-response watchdog bound.
 */
import { EventType } from '../../src/agent-session/schemas/events';
import { Sessions } from '../../src/agent-session/Sessions';
import { InMemorySessionStore } from '../../src/agent-session/store/InMemorySessionStore';
import { TurnResourceResolver } from '../../src/agent-session/TurnResourceResolver';
import type { ILLM, LLMCreateParamsStreaming } from '../../src/core/llm/ILLM';
import type { ExtendedChatCompletionChunk, RawAssistantMessageWithUsage } from '../../src/core/llm/LLMTypes';
import { getEmptyUsage } from '../../src/core/llm/LLMTypes';
import { toolResultResponse, type IToolSet } from '../../src/core/mcp/IMCPServer';
import type { HostToolCallPolicy } from '../../src/core/runtime/HostToolCallPolicy';
import { makeMockIMCPServer, OBJECT_INPUT_SCHEMA } from '../core/harnessMocks';
import { emptyLlmStream, makeAgentSpec, makeSilentLogger, mintTestTurnId } from './testHelpers';

const BLOCK_MESSAGE = 'Host policy: the library already answered this question.';

// eslint-disable-next-line @typescript-eslint/require-await -- async generator fixture, not awaiting I/O
async function* toolCallStream(input: {
  name: string;
  args: Record<string, unknown>;
}): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  const call = {
    id: 'call-1',
    type: 'function' as const,
    function: { name: input.name, arguments: JSON.stringify(input.args) },
  };
  yield {
    id: 'chunk-1',
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
}

/** Never yields and never errors: the silent-provider shape the watchdog exists for. */
async function* hangingStream(): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  await new Promise<never>(() => undefined);
  yield* emptyLlmStream();
  return { output: { role: 'assistant', content: 'never' }, usage: getEmptyUsage(), finish_reason: 'stop' };
}

function makeWebToolSet(): IToolSet {
  const toolSet = makeMockIMCPServer({
    name: 'web',
    preload: true,
    tools: [{ name: 'web_search', description: 'Search the web', inputSchema: OBJECT_INPUT_SCHEMA, preload: true }],
  });
  jest.mocked(toolSet.toolCallInfo).mockImplementation(params =>
    Promise.resolve({
      type: 'mcp',
      mcp_server_id: toolSet.id,
      mcp_server_name: toolSet.name,
      original_tool_name: params.name,
      is_approval_required: false,
    }),
  );
  jest.mocked(toolSet.callTool).mockImplementation(() => Promise.resolve(toolResultResponse({ text: 'web results' })));
  return toolSet;
}

/** The real resolver class, with one extra tool set attached to every thread. */
class ToolSetResolver extends TurnResourceResolver {
  constructor(
    deps: ConstructorParameters<typeof TurnResourceResolver>[0],
    private readonly toolSet: IToolSet,
  ) {
    super(deps);
  }

  override async resolveAgentDefinition(input: Parameters<TurnResourceResolver['resolveAgentDefinition']>[0]) {
    const resolved = await super.resolveAgentDefinition(input);
    return {
      ...resolved,
      extraCapabilities: [...(resolved.extraCapabilities ?? []), { systemToolSets: [this.toolSet] }],
    };
  }
}

function pendingApprovals(turn: Awaited<ReturnType<typeof runTurn>>): string[] {
  if (turn.state.status !== 'done') {
    return [];
  }
  return (turn.state.required_actions ?? []).flatMap(action =>
    action.type === 'tool.approval_required' ? action.tool_calls.map(call => call.id) : [],
  );
}

function makeResolver(input: {
  modelClient: ILLM;
  toolSet: IToolSet;
  toolCallPolicy?: HostToolCallPolicy | undefined;
  modelFirstResponseTimeoutMs?: number | undefined;
}) {
  return new ToolSetResolver(
    {
      llm: () =>
        Promise.resolve({
          modelClient: input.modelClient,
          defaultModelParams: {},
          modelId: undefined,
          modelSupportsVision: false,
        }),
      mcp: name => Promise.reject(new Error(`unexpected mcp lookup: ${name}`)),
      mcpRequestTimeoutMs: 60_000,
      mcpConnectTimeoutMs: 5_000,
      logger: makeSilentLogger(),
      toolCallPolicy: input.toolCallPolicy,
      modelFirstResponseTimeoutMs: input.modelFirstResponseTimeoutMs,
    },
    input.toolSet,
  );
}

/** Calls the advertised web_search tool once, then answers. */
function webSearchingModel(requests: LLMCreateParamsStreaming[]): ILLM {
  return {
    create: jest.fn((request: LLMCreateParamsStreaming) => {
      requests.push(request);
      if (requests.length > 1) {
        return emptyLlmStream();
      }
      const name = request.tools
        ?.flatMap(tool => (tool.type === 'function' ? [tool.function.name] : []))
        .find(candidate => candidate.includes('web_search'));
      if (name === undefined) {
        throw new Error('web_search was not advertised to the model');
      }
      return toolCallStream({ name, args: { query: 'library question' } });
    }),
    createNonStream: jest.fn(),
  };
}

async function runTurn(resolver: TurnResourceResolver) {
  const store = new InMemorySessionStore();
  const session = await new Sessions({ sessionStore: store }).create({
    tenant_id: 'tenant-1',
    session_id: 's1',
    created_by_subject: { subject_id: 'user-1', subject_type: 'user', subject_display_name: 'user-1' },
    agent: { type: 'inline', spec: makeAgentSpec() },
    external_id: null,
  });
  const turn = await session.createTurn({
    turn_id: mintTestTurnId(),
    input: [{ type: EventType.USER_MESSAGE, content: 'What does my library say?' }],
    previous_turn_id: 'none',
    signal: new AbortController().signal,
    resolver,
  });
  for await (const event of turn.stream()) {
    void event;
  }
  return turn;
}

describe('TurnResourceResolver host controls reach the turn', () => {
  it('blocks a tool call the host policy rejects before it is dispatched', async () => {
    const toolSet = makeWebToolSet();
    const requests: LLMCreateParamsStreaming[] = [];
    const policy = jest.fn<ReturnType<HostToolCallPolicy>, Parameters<HostToolCallPolicy>>(call =>
      call.underlyingToolName === 'web_search' ? { message: BLOCK_MESSAGE } : undefined,
    );

    const turn = await runTurn(
      makeResolver({ modelClient: webSearchingModel(requests), toolSet, toolCallPolicy: policy }),
    );

    expect(turn.state.status).toBe('done');
    expect(policy).toHaveBeenCalledWith(
      expect.objectContaining({ underlyingToolName: 'web_search', args: { query: 'library question' } }),
    );
    // Blocked calls never run and never reach the approval gate: the model
    // gets the host message as the tool error and answers.
    expect(toolSet.callTool).not.toHaveBeenCalled();
    expect(pendingApprovals(turn)).toEqual([]);
    expect(JSON.stringify(requests[1]?.messages)).toContain(BLOCK_MESSAGE);
  });

  it('leaves an allowed call on the normal approval path', async () => {
    const requests: LLMCreateParamsStreaming[] = [];

    const turn = await runTurn(
      makeResolver({
        modelClient: webSearchingModel(requests),
        toolSet: makeWebToolSet(),
        toolCallPolicy: () => undefined,
      }),
    );

    expect(turn.state.status).toBe('done');
    expect(pendingApprovals(turn)).toEqual(['call-1']);
    expect(requests).toHaveLength(1);
  });

  it('applies the configured first-response bound instead of the ten-minute default', async () => {
    const modelClient: ILLM = { create: jest.fn(() => hangingStream()), createNonStream: jest.fn() };

    const turn = await runTurn(
      makeResolver({ modelClient, toolSet: makeWebToolSet(), modelFirstResponseTimeoutMs: 200 }),
    );

    expect(turn.state.status).toBe('error');
    expect(turn.state.status === 'error' ? turn.state.message : '').toContain('no output within 1 second');
  });
});

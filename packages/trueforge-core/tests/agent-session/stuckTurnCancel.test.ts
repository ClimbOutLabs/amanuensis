import { EventType } from '../../src/agent-session/schemas/events';
import { CancellationReason } from '../../src/agent-session/schemas/turn';
import { Sessions } from '../../src/agent-session/Sessions';
import { InMemorySessionStore } from '../../src/agent-session/store/InMemorySessionStore';
import { TurnResourceResolver } from '../../src/agent-session/TurnResourceResolver';
import type { ILLM } from '../../src/core/llm/ILLM';
import type { ExtendedChatCompletionChunk, RawAssistantMessageWithUsage } from '../../src/core/llm/LLMTypes';
import { getEmptyUsage } from '../../src/core/llm/LLMTypes';
import { toolResultResponse, type IToolSet } from '../../src/core/mcp/IMCPServer';
import { MODEL_STOPPED_ANSWERING_MESSAGE } from '../../src/core/runtime/AgentThread';
import { makeMockIMCPServer, OBJECT_INPUT_SCHEMA } from '../core/harnessMocks';
import { emptyLlmStream, makeAgentSpec, makeSilentLogger, mintTestTurnId } from './testHelpers';

/** Cancel must end the turn this fast in every state; the stalls below would otherwise last forever. */
const CANCEL_BUDGET_MS = 2_000;

// eslint-disable-next-line @typescript-eslint/require-await -- async generator fixture, not awaiting I/O
async function* searchCall(
  name: string,
): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  const call = { id: 'call-1', type: 'function' as const, function: { name, arguments: '{"query":"events tonight"}' } };
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

/** Accepts the request and then never says anything, the provider shape behind the stuck turn. */
async function* silentStream(): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  await new Promise<never>(() => undefined);
  yield* emptyLlmStream();
  return { output: { role: 'assistant', content: 'never' }, usage: getEmptyUsage(), finish_reason: 'stop' };
}

/** Searches the web once, then goes silent on the continuation after the result. */
function searchThenSilentModel(): ILLM {
  let calls = 0;
  return {
    create: jest.fn(request => {
      calls += 1;
      if (calls > 1) {
        return silentStream();
      }
      const name = request.tools
        ?.flatMap(tool => (tool.type === 'function' ? [tool.function.name] : []))
        .find(candidate => candidate.includes('web_search'));
      if (name === undefined) {
        throw new Error('web_search was not advertised to the model');
      }
      return searchCall(name);
    }),
    createNonStream: jest.fn(),
  };
}

function makeWebToolSet(options: { approval: boolean; callTool: () => ReturnType<IToolSet['callTool']> }): IToolSet {
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
      is_approval_required: options.approval,
      // Already classified, so a call that needs no approval runs instead of parking behind a card.
      ...(options.approval ? {} : { tier: 1 as const }),
    }),
  );
  jest.mocked(toolSet.callTool).mockImplementation(options.callTool);
  return toolSet;
}

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
      definition: { ...resolved.definition, toolSets: [...(resolved.definition.toolSets ?? []), this.toolSet] },
    };
  }
}

function makeResolver(input: { modelClient: ILLM; toolSet: IToolSet; modelFirstResponseTimeoutMs?: number }) {
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
      modelFirstResponseTimeoutMs: input.modelFirstResponseTimeoutMs,
    },
    input.toolSet,
  );
}

/** Starts a turn and returns it with its event types, its end, and the controller Cancel aborts. */
async function startTurn(resolver: TurnResourceResolver) {
  const store = new InMemorySessionStore();
  const session = await new Sessions({ sessionStore: store }).create({
    tenant_id: 'tenant-1',
    session_id: 's1',
    created_by_subject: { subject_id: 'user-1', subject_type: 'user', subject_display_name: 'user-1' },
    agent: { type: 'inline', spec: makeAgentSpec() },
    external_id: null,
  });
  const controller = new AbortController();
  const turn = await session.createTurn({
    turn_id: mintTestTurnId(),
    input: [{ type: EventType.USER_MESSAGE, content: 'What is on in town tonight?' }],
    previous_turn_id: 'none',
    signal: controller.signal,
    resolver,
  });
  const types: string[] = [];
  const finished = (async () => {
    for await (const event of turn.stream()) {
      types.push(event.type);
    }
  })();
  return { turn, types, finished, controller };
}

async function until(condition: () => boolean): Promise<void> {
  while (!condition()) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

/** Cancels and measures how long the turn takes to reach its terminal state. */
async function cancelAndTime(input: { controller: AbortController; finished: Promise<void> }): Promise<number> {
  const startedAt = Date.now();
  input.controller.abort(CancellationReason.ClientCancelled);
  await input.finished;
  return Date.now() - startedAt;
}

describe('a turn stuck after a tool result', () => {
  it('ends with the plain message and keeps the search step when the model stays silent', async () => {
    const toolSet = makeWebToolSet({
      approval: false,
      callTool: () => Promise.resolve(toolResultResponse({ text: 'A concert at the harbour.' })),
    });
    const { turn, types, finished } = await startTurn(
      makeResolver({ modelClient: searchThenSilentModel(), toolSet, modelFirstResponseTimeoutMs: 200 }),
    );
    await finished;

    expect(turn.state.status).toBe('error');
    expect(turn.state.status === 'error' ? turn.state.message : '').toBe(MODEL_STOPPED_ANSWERING_MESSAGE);
    expect(toolSet.callTool).toHaveBeenCalledTimes(1);
    expect(types).toContain(EventType.TOOL_RESPONSE_V2);
  });

  it('stops on Cancel while waiting for the model, keeping the search step', async () => {
    const toolSet = makeWebToolSet({
      approval: false,
      callTool: () => Promise.resolve(toolResultResponse({ text: 'A concert at the harbour.' })),
    });
    const modelClient = searchThenSilentModel();
    const { turn, types, finished, controller } = await startTurn(makeResolver({ modelClient, toolSet }));
    await until(() => jest.mocked(modelClient.create).mock.calls.length >= 2);

    const elapsed = await cancelAndTime({ controller, finished });

    expect(elapsed).toBeLessThan(CANCEL_BUDGET_MS);
    expect(turn.state.status).toBe('cancelled');
    expect(types).toContain(EventType.TOOL_RESPONSE_V2);
  });

  it('stops on Cancel while a tool is running', async () => {
    const toolSet = makeWebToolSet({ approval: false, callTool: () => new Promise(() => undefined) });
    const { turn, finished, controller } = await startTurn(
      makeResolver({ modelClient: searchThenSilentModel(), toolSet }),
    );
    await until(() => jest.mocked(toolSet.callTool).mock.calls.length >= 1);

    const elapsed = await cancelAndTime({ controller, finished });

    expect(elapsed).toBeLessThan(CANCEL_BUDGET_MS);
    expect(turn.state.status).toBe('cancelled');
  });

  it('does not hold a turn open while an approval waits, so there is nothing left running', async () => {
    const toolSet = makeWebToolSet({
      approval: true,
      callTool: () => Promise.resolve(toolResultResponse({ text: 'never run' })),
    });
    const { turn, finished } = await startTurn(makeResolver({ modelClient: searchThenSilentModel(), toolSet }));
    await finished;

    // The turn ends waiting on the card instead of running, so Cancel has nothing on the server to stop.
    expect(turn.state.status).toBe('done');
    expect(turn.state.status === 'done' ? turn.state.required_actions.length : 0).toBe(1);
    expect(toolSet.callTool).not.toHaveBeenCalled();
  });
});

import { EventType } from '../../../src/core/events/schema';
import type { ILLM } from '../../../src/core/llm/ILLM';
import type { ExtendedChatCompletionChunk, RawAssistantMessageWithUsage } from '../../../src/core/llm/LLMTypes';
import { getEmptyUsage } from '../../../src/core/llm/LLMTypes';
import { toolResultResponse, type IToolSet } from '../../../src/core/mcp/IMCPServer';
import { AgentThread } from '../../../src/core/runtime/AgentThread';
import { InternalEventType } from '../../../src/core/runtime/AgentThread.types';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { finalAnswerStream, makeMockIMCPServer, makeSilentLogger, OBJECT_INPUT_SCHEMA } from '../harnessMocks';

/**
 * A toolset with a `lookup` tool that always succeeds and a `ghost` tool whose
 * server answers with clientSideToolRequired — a response the executor drops
 * without producing a tool message, so the call stays open. Before the fix,
 * the next deriveState() threw "Invalid state transition:
 * tool-response-required → tool-response-required" and killed the turn.
 */
// eslint-disable-next-line @typescript-eslint/require-await -- async generator fixture, not awaiting I/O
async function* toolCallStream({
  id,
  name,
  args,
}: {
  id: string;
  name: string;
  args: Record<string, unknown>;
}): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  const call = { id, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } };
  yield {
    id: `chunk-${id}`,
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

/** Same as {@link toolCallStream} but for one assistant message making several tool calls at once. */
// eslint-disable-next-line @typescript-eslint/require-await -- async generator fixture, not awaiting I/O
async function* multiToolCallStream(
  calls: { id: string; name: string; args: Record<string, unknown> }[],
): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  const toolCalls = calls.map(({ id, name, args }) => ({
    id,
    type: 'function' as const,
    function: { name, arguments: JSON.stringify(args) },
  }));
  yield {
    id: 'chunk-mixed-batch',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test-model',
    choices: [
      {
        index: 0,
        delta: { role: 'assistant', tool_calls: toolCalls.map((call, index) => ({ index, ...call })) },
        finish_reason: null,
      },
    ],
  };
  return {
    output: { role: 'assistant', content: null, tool_calls: toolCalls },
    usage: getEmptyUsage(),
    finish_reason: 'tool_calls',
  };
}

function makeOrphanToolSet(): IToolSet {
  const toolSet = makeMockIMCPServer({
    name: 'test',
    preload: true,
    tools: [
      { name: 'lookup', description: 'Look something up', inputSchema: OBJECT_INPUT_SCHEMA, preload: true },
      {
        name: 'ghost',
        description: 'A tool whose server never returns a result',
        inputSchema: OBJECT_INPUT_SCHEMA,
        preload: true,
      },
      { name: 'write', description: 'Write a file', inputSchema: OBJECT_INPUT_SCHEMA, preload: true },
      { name: 'danger', description: 'Approval-required edit', inputSchema: OBJECT_INPUT_SCHEMA, preload: true },
    ],
  });
  jest.mocked(toolSet.toolCallInfo).mockImplementation(params =>
    Promise.resolve({
      type: 'mcp',
      mcp_server_id: toolSet.id,
      mcp_server_name: toolSet.name,
      original_tool_name: params.name,
      is_approval_required: params.name === 'danger',
      is_client_side: false,
      effect: params.name === 'write' || params.name === 'danger' ? 'edit' : 'inspect',
    }),
  );
  jest.mocked(toolSet.callTool).mockImplementation(params => {
    if (params.name === 'ghost' || params.name === 'write') {
      // The server-side safety-net response for a client-side tool that
      // reached dispatch: the executor records no tool message for it.
      return Promise.resolve({
        clientSideToolRequired: {
          tool_info: {
            type: 'mcp',
            mcp_server_id: toolSet.id,
            mcp_server_name: toolSet.name,
            original_tool_name: params.name,
            is_approval_required: false,
            is_client_side: false,
          },
        },
      });
    }
    return Promise.resolve(toolResultResponse({ text: 'ok' }));
  });
  return toolSet;
}

async function runThread(toolSet: IToolSet, create: jest.Mock): Promise<unknown[]> {
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
    context: [{ role: 'user', content: 'Do the thing.' }],
  });
  const events: unknown[] = [];
  for await (const event of thread.execute({ signal: new AbortController().signal })) {
    events.push(event);
  }
  return events;
}

function fatalErrors(events: unknown[]): unknown[] {
  return events.filter(
    event =>
      typeof event === 'object' &&
      event !== null &&
      (event as { type?: unknown }).type === InternalEventType.AGENT_DONE &&
      (event as { status?: unknown }).status === 'error',
  );
}

function toolResponses(events: unknown[]): { tool_call_id: string; event: unknown }[] {
  return events
    .filter(
      event =>
        typeof event === 'object' &&
        event !== null &&
        (event as { type?: unknown }).type === EventType.TOOL_RESPONSE_V2,
    )
    .map(event => ({ tool_call_id: (event as { tool_call_id: string }).tool_call_id, event }));
}

describe('orphaned tool call recovery', () => {
  it('synthesizes a terminal error result for a single orphaned call and continues the turn', async () => {
    const toolSet = makeOrphanToolSet();
    const create = jest
      .fn()
      .mockImplementationOnce(() => toolCallStream({ id: 'ghost-1', name: 'ghost', args: {} }))
      .mockImplementationOnce(() => finalAnswerStream());
    const events = await runThread(toolSet, create);

    expect(fatalErrors(events)).toHaveLength(0);
    const responses = toolResponses(events);
    expect(responses.map(r => r.tool_call_id)).toEqual(['ghost-1']);
    // A read-only orphan provably never ran: the model may retry it.
    expect(responses[0]?.event).toMatchObject({
      tool_call_id: 'ghost-1',
      disposition: 'never_ran',
      remediation: expect.objectContaining({ reason_code: 'tool_call_never_ran' }),
    });
    const content = (responses[0]?.event as { content?: string }).content ?? '';
    expect(content).toContain('not executed');
    expect(create).toHaveBeenCalledTimes(2);
    expect(events.at(-1)).toMatchObject({ type: InternalEventType.AGENT_DONE, status: 'done' });
  });

  it('recovers a partial batch: the good call keeps its real result, the orphan gets a synthetic one', async () => {
    const toolSet = makeOrphanToolSet();
    const create = jest
      .fn()
      .mockImplementationOnce(() =>
        multiToolCallStream([
          { id: 'lookup-1', name: 'lookup', args: {} },
          { id: 'ghost-1', name: 'ghost', args: {} },
        ]),
      )
      .mockImplementationOnce(() => finalAnswerStream());
    const events = await runThread(toolSet, create);

    expect(fatalErrors(events)).toHaveLength(0);
    const responses = toolResponses(events);
    expect(responses.map(r => r.tool_call_id).sort()).toEqual(['ghost-1', 'lookup-1']);
    const byId = new Map(responses.map(r => [r.tool_call_id, r.event]));
    expect(byId.get('lookup-1')).toMatchObject({ disposition: 'executed_ok' });
    expect((byId.get('lookup-1') as { content?: string }).content).toContain('ok');
    expect(byId.get('ghost-1')).toMatchObject({
      disposition: 'never_ran',
      remediation: expect.objectContaining({ reason_code: 'tool_call_never_ran' }),
    });
    expect(create).toHaveBeenCalledTimes(2);
    expect(events.at(-1)).toMatchObject({ type: InternalEventType.AGENT_DONE, status: 'done' });
  });

  it('closes a durably-started side-effecting orphan as outcome unknown, not as never ran', async () => {
    const toolSet = makeOrphanToolSet();
    const create = jest
      .fn()
      .mockImplementationOnce(() => toolCallStream({ id: 'write-1', name: 'write', args: {} }))
      .mockImplementationOnce(() => finalAnswerStream());
    const events = await runThread(toolSet, create);

    expect(fatalErrors(events)).toHaveLength(0);
    const responses = toolResponses(events);
    expect(responses.map(r => r.tool_call_id)).toEqual(['write-1']);
    // The call crossed the durable execution boundary, so the model must not
    // be told it never ran: it may already have taken effect.
    expect(responses[0]?.event).toMatchObject({
      tool_call_id: 'write-1',
      disposition: 'outcome_unknown',
      remediation: expect.objectContaining({ reason_code: 'missing_terminal_result' }),
    });
    const content = (responses[0]?.event as { content?: string }).content ?? '';
    expect(content).toContain('outcome unknown');
    expect(events.at(-1)).toMatchObject({ type: InternalEventType.AGENT_DONE, status: 'done' });
  });

  it('recovers an orphaned read as never_ran even when the batch contained an approved side-effecting call', async () => {
    const toolSet = makeOrphanToolSet();
    const create = jest
      .fn()
      .mockImplementationOnce(() =>
        multiToolCallStream([
          { id: 'danger-1', name: 'danger', args: {} },
          { id: 'ghost-1', name: 'ghost', args: {} },
        ]),
      )
      .mockImplementation(() => finalAnswerStream());
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
      context: [{ role: 'user', content: 'Do the thing.' }],
    });
    const drain = async (gen: AsyncGenerator<unknown>): Promise<unknown[]> => {
      const events: unknown[] = [];
      for await (const event of gen) {
        events.push(event);
      }
      return events;
    };

    // The turn must pause for approval: nothing dispatches and nothing is
    // synthesized before the user decides.
    const firstEvents = await drain(thread.execute({ signal: new AbortController().signal }));
    expect(fatalErrors(firstEvents)).toHaveLength(0);
    const approvalCards = firstEvents.filter(
      event =>
        typeof event === 'object' &&
        event !== null &&
        (event as { type?: unknown }).type === EventType.TOOL_APPROVAL_REQUIRED,
    );
    expect(approvalCards).toHaveLength(1);
    expect(toolResponses(firstEvents)).toHaveLength(0);

    // The user allows; the turn continues.
    await drain(
      thread.send([
        {
          type: EventType.USER_TOOL_APPROVAL,
          thread_id: 'main',
          tool_call_id: 'danger-1',
          approval: { status: 'allow', scope: 'once' },
        },
      ]),
    );
    const secondEvents = await drain(thread.execute({ signal: new AbortController().signal }));
    expect(fatalErrors(secondEvents)).toHaveLength(0);
    const responses = toolResponses(secondEvents);
    const byId = new Map(responses.map(r => [r.tool_call_id, r.event]));
    // The approved call ran for real...
    expect(byId.get('danger-1')).toMatchObject({ disposition: 'executed_ok' });
    // ...and the orphaned read is honestly reported as never ran — the
    // approval decision must not be shadowed by the execution markers, or the
    // read would be misreported as outcome unknown.
    expect(byId.get('ghost-1')).toMatchObject({
      disposition: 'never_ran',
      remediation: expect.objectContaining({ reason_code: 'tool_call_never_ran' }),
    });
    expect(secondEvents.at(-1)).toMatchObject({ type: InternalEventType.AGENT_DONE, status: 'done' });
  });
});

import type { ILLM } from '../../../src/core/llm/ILLM';
import type { ExtendedChatCompletionChunk, RawAssistantMessageWithUsage } from '../../../src/core/llm/LLMTypes';
import { getEmptyUsage } from '../../../src/core/llm/LLMTypes';
import { toolResultResponse, type IToolSet } from '../../../src/core/mcp/IMCPServer';
import { AgentThread } from '../../../src/core/runtime/AgentThread';
import { InternalEventType } from '../../../src/core/runtime/AgentThread.types';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { finalAnswerStream, makeMockIMCPServer, makeSilentLogger, OBJECT_INPUT_SCHEMA } from '../harnessMocks';

/**
 * Structural task-state tests: the host-owned scratchpad + tool-call budget.
 *
 * A research turn banks findings via `record_finding`; the host re-injects a
 * fresh `<task_state>` block before every model call (immune to context
 * compaction by construction); and once the configured tool-call budget is
 * spent the host withholds the configured budgeted research tools, forcing
 * the final-answer pass instead of letting the model decide whether to keep
 * researching. Control, approval, host, and unrelated tools stay available.
 */
// eslint-disable-next-line @typescript-eslint/require-await -- async generator fixture, not awaiting I/O
async function* toolCallStream({
  id,
  toolName,
  args,
}: {
  id: string;
  toolName: string;
  args: Record<string, unknown>;
}): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  const call = { id, type: 'function' as const, function: { name: toolName, arguments: JSON.stringify(args) } };
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

function makeSearchToolSet(): IToolSet {
  const toolSet = makeMockIMCPServer({
    name: 'search-provider',
    preload: true,
    tools: [{ name: 'search', description: 'Search the web', inputSchema: OBJECT_INPUT_SCHEMA, preload: true }],
  });
  jest.mocked(toolSet.toolCallInfo).mockImplementation(params =>
    Promise.resolve({
      type: 'mcp',
      mcp_server_id: toolSet.id,
      mcp_server_name: toolSet.name,
      original_tool_name: params.name,
      is_approval_required: false,
      effect: 'inspect',
    }),
  );
  jest
    .mocked(toolSet.callTool)
    .mockImplementation(() => Promise.resolve(toolResultResponse({ text: 'Madrid rent update.' })));
  return toolSet;
}

interface CreateRequestShape {
  tools?: { type: string; function: { name: string } }[];
  messages: { role: string; content: unknown }[];
}

function requestOf(create: jest.Mock, callIndex: number): CreateRequestShape {
  return create.mock.calls[callIndex]?.[0] as CreateRequestShape;
}

function taskStateBlocksOf(request: CreateRequestShape): string[] {
  return request.messages
    .filter(m => m.role === 'system' && typeof m.content === 'string' && m.content.includes('<task_state>'))
    .map(m => m.content as string);
}

describe('host-owned task state and tool-call budget', () => {
  it('injects a fresh <task_state> block on every call, exempts record_finding, and withholds budgeted tools at exhaustion', async () => {
    const toolSet = makeSearchToolSet();
    const findingArgs = {
      label: 'Spain/Madrid',
      headline: 'Average student-room rent hits 689 €/month.',
      why_it_matters: 'Sets the budget baseline for the Madrid move.',
      url: 'https://example.com/madrid-rent',
    };
    const create = jest.fn();
    // Budget is 2: search, record_finding (exempt), search → exhausted.
    // The two searches use distinct queries so the second is not memoized.
    create
      .mockImplementationOnce(() =>
        toolCallStream({ id: 'search-1', toolName: 'search', args: { query: 'Madrid rental market September 2026' } }),
      )
      .mockImplementationOnce(() => {
        const firstRequest = requestOf(create, 0);
        const recordFindingName =
          firstRequest.tools?.find(t => t.function.name.includes('record_finding'))?.function.name ?? 'record_finding';
        return toolCallStream({ id: 'finding-1', toolName: recordFindingName, args: findingArgs });
      })
      .mockImplementationOnce(() =>
        toolCallStream({
          id: 'search-2',
          toolName: 'search',
          args: { query: 'Madrid student room rent average 2026' },
        }),
      )
      .mockImplementation(() => finalAnswerStream());
    const modelClient: ILLM = { create, createNonStream: jest.fn() };

    const thread = new AgentThread({
      threadId: 'main',
      title: 'Main',
      toolCallMemo: undefined,
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
        iterationLimit: 100,
        toolCallBudget: 2,
        budgetedTools: ['search'],
      },
      context: [{ role: 'user', content: 'Brief me on Madrid rentals' }],
    });

    const events: unknown[] = [];
    for await (const event of thread.execute({ signal: new AbortController().signal })) {
      events.push(event);
    }

    expect(events.at(-1)).toMatchObject({ type: InternalEventType.AGENT_DONE, status: 'done' });
    expect(create).toHaveBeenCalledTimes(4);

    // record_finding is offered alongside the research tools…
    const firstTools = requestOf(create, 0).tools ?? [];
    expect(firstTools.some(t => t.function.name.includes('record_finding'))).toBe(true);

    // …a fresh <task_state> block precedes every model call…
    for (let i = 0; i < 4; i++) {
      expect(taskStateBlocksOf(requestOf(create, i))).toHaveLength(1);
    }

    // …the banked finding shows up in later blocks…
    expect(taskStateBlocksOf(requestOf(create, 2))[0]).toContain('689 €/month');
    expect(taskStateBlocksOf(requestOf(create, 3))[0]).toContain('689 €/month');

    // …and once the budget is spent the host withholds the budgeted research
    // tool while record_finding and unrelated infrastructure (e.g. the
    // deferred-loading meta-tools) stay available, forcing the answer pass.
    // Note: a call_tool invocation targeting a budgeted tool is still
    // blocked/charged, because enrichment resolves call_tool to the
    // underlying tool's original name before admission.
    const exhaustedBlock = taskStateBlocksOf(requestOf(create, 3))[0];
    expect(exhaustedBlock).toContain('budget exhausted');
    const exhaustedTools = requestOf(create, 3).tools ?? [];
    const exhaustedNames = exhaustedTools.map(t => t.function.name);
    expect(exhaustedNames).not.toContain('search');
    expect(exhaustedNames.some(name => name.includes('record_finding'))).toBe(true);

    // The two searches actually executed; record_finding did not consume budget.
    expect(jest.mocked(toolSet.callTool)).toHaveBeenCalledTimes(2);

    // The pre-dispatch reservation is persisted before the provider runs:
    // an append carrying the reserved count (1) precedes the first tool
    // result, so a crash between admission and dispatch fails closed.
    const appends = events.filter(
      (event): event is { task_state?: { tool_calls_used?: number } } =>
        typeof event === 'object' &&
        event !== null &&
        (event as { type?: string }).type === InternalEventType.AGENT_CONTEXT_APPEND,
    );
    const reservedCounts = appends.map(event => event.task_state?.tool_calls_used);
    expect(reservedCounts).toContain(1);

    // Snapshot carries the scratchpad for continuations.
    const snapshot = thread.toSnapshot();
    expect(snapshot.task_state?.findings).toHaveLength(1);
    expect(snapshot.task_state?.tool_calls_used).toBe(2);
  });

  it('stays fully inert when no budget is configured', async () => {
    const toolSet = makeSearchToolSet();
    const create = jest
      .fn()
      .mockImplementationOnce(() => toolCallStream({ id: 'search-1', toolName: 'search', args: { query: 'x' } }))
      .mockImplementation(() => finalAnswerStream());
    const modelClient: ILLM = { create, createNonStream: jest.fn() };

    const thread = new AgentThread({
      threadId: 'main',
      title: 'Main',
      toolCallMemo: undefined,
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
        iterationLimit: 100,
      },
      context: [{ role: 'user', content: 'Brief me on Madrid rentals' }],
    });

    for await (const _event of thread.execute({ signal: new AbortController().signal })) {
      // drain
    }

    const tools = requestOf(create, 0).tools ?? [];
    expect(tools.some(t => t.function.name.includes('record_finding'))).toBe(false);
    expect(taskStateBlocksOf(requestOf(create, 0))).toHaveLength(0);
    expect(thread.toSnapshot().task_state?.findings).toHaveLength(0);
  });
});

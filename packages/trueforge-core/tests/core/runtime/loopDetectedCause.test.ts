import type { ILLM } from '../../../src/core/llm/ILLM';
import type { ExtendedChatCompletionChunk, RawAssistantMessageWithUsage } from '../../../src/core/llm/LLMTypes';
import { getEmptyUsage } from '../../../src/core/llm/LLMTypes';
import { toolResultResponse, type IToolSet } from '../../../src/core/mcp/IMCPServer';
import { AgentThread } from '../../../src/core/runtime/AgentThread';
import { InternalEventType } from '../../../src/core/runtime/AgentThread.types';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { finalAnswerStream, makeMockIMCPServer, makeSilentLogger, OBJECT_INPUT_SCHEMA } from '../harnessMocks';

/**
 * Regression test for the loop-protection handoff cause.
 *
 * A scheduled agent that repeats the same read-only search gets its second
 * identical call served from the tool-call memo. That memoized replay is a
 * provable no-progress loop, so the turn stops — but the stop must be reported
 * as `loop_detected`, not `iteration_limit`: the per-turn step budget is not
 * what ran out, and reporting `iteration_limit` sends operators to check (and
 * raise) a limit that was never the problem.
 */
// eslint-disable-next-line @typescript-eslint/require-await -- async generator fixture, not awaiting I/O
async function* searchCallStream({
  id,
  args,
}: {
  id: string;
  args: Record<string, unknown>;
}): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  const call = { id, type: 'function' as const, function: { name: 'search', arguments: JSON.stringify(args) } };
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
    .mockImplementation(() =>
      Promise.resolve(
        toolResultResponse({ text: 'Result 1: Madrid rental market update. Result 2: NLV processing times.' }),
      ),
    );
  return toolSet;
}

describe('loop_detected handoff cause', () => {
  it('recovers with a final answer (not an error) when a memoized read is repeated once', async () => {
    const toolSet = makeSearchToolSet();
    const madrid = { query: 'Madrid rental market September 2026' };
    const other = { query: 'NLV processing times' };
    // The repeat is not the call straight after the first one, so it is refused as a repeat
    // without ending the turn; the model then answers.
    const create = jest
      .fn()
      .mockImplementationOnce(() => searchCallStream({ id: 'search-1', args: madrid }))
      .mockImplementationOnce(() => searchCallStream({ id: 'search-2', args: other }))
      .mockImplementationOnce(() => searchCallStream({ id: 'search-3', args: madrid }))
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
        iterationLimit: 100,
      },
      context: [{ role: 'user', content: 'Brief me on Madrid rentals' }],
    });

    const events: unknown[] = [];
    for await (const event of thread.execute({ signal: new AbortController().signal })) {
      events.push(event);
    }

    // The repeated search is refused before dispatch (no new information possible), so only the
    // two distinct searches run. The model answers, so the turn succeeds instead of ending blank.
    expect(jest.mocked(toolSet.callTool)).toHaveBeenCalledTimes(2);
    expect(events.at(-1)).toMatchObject({ type: InternalEventType.AGENT_DONE, status: 'done' });
    // The recovery must not be misreported as the step budget running out.
    expect(events).not.toContainEqual(
      expect.objectContaining({
        type: InternalEventType.AGENT_DONE,
        status: 'error',
        handoff_cause: 'iteration_limit',
      }),
    );
  });

  it('reports loop_detected (not iteration_limit) when the model repeats after recovery', async () => {
    const toolSet = makeSearchToolSet();
    const madrid = { query: 'Madrid rental market September 2026' };
    const other = { query: 'NLV processing times' };
    const third = { query: 'Valencia rental prices' };
    // Madrid is searched four times, with other searches between, so no repeat is consecutive.
    // The fourth Madrid search trips the repeat budget (first fire: recovery note). The model then
    // searches Valencia, and its next Madrid search is the second fire, which ends the turn.
    const sequence = [madrid, other, madrid, other, madrid, other, madrid, third, madrid];
    const create = jest.fn();
    sequence.forEach((args, index) => {
      create.mockImplementationOnce(() => searchCallStream({ id: `search-${String(index + 1)}`, args }));
    });
    create.mockImplementation(() => finalAnswerStream());
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
        iterationLimit: 100,
      },
      context: [{ role: 'user', content: 'Brief me on Madrid rentals' }],
    });

    const events: unknown[] = [];
    for await (const event of thread.execute({ signal: new AbortController().signal })) {
      events.push(event);
    }

    // The model ignored the recovery note and kept repeating the search.
    // The turn stops, and the stop must be reported as loop_detected, not
    // iteration_limit: the per-turn step budget (100) is not what ran out.
    expect(events).toContainEqual(
      expect.objectContaining({
        type: InternalEventType.AGENT_DONE,
        status: 'error',
        handoff_cause: 'loop_detected',
      }),
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({
        type: InternalEventType.AGENT_DONE,
        status: 'error',
        handoff_cause: 'iteration_limit',
      }),
    );
  });
});

import { ToolPolicyBlockedError } from '../../../src/core/errors';
import type { ILLM, LLMCreateParamsStreaming } from '../../../src/core/llm/ILLM';
import type { ExtendedChatCompletionChunk, RawAssistantMessageWithUsage } from '../../../src/core/llm/LLMTypes';
import { getEmptyUsage } from '../../../src/core/llm/LLMTypes';
import { createTurnToolCallLedger, type TurnToolCallLedger } from '../../../src/core/mcp/executeToolCalls';
import { toolResultResponse, type IToolSet } from '../../../src/core/mcp/IMCPServer';
import { AgentThread } from '../../../src/core/runtime/AgentThread';
import type { AgentParent } from '../../../src/core/runtime/AgentThread.types';
import {
  REMOVED_TOOL_RESULT,
  REMOVED_TOOL_STREAK_MESSAGE,
  STEP_BUDGET_SPENT_MESSAGE,
} from '../../../src/core/runtime/replyBudget';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { finalAnswerStream, makeMockIMCPServer, makeSilentLogger, OBJECT_INPUT_SCHEMA } from '../harnessMocks';

/**
 * A toolset for the reply budget. `create_event` is refused by the tool policy when `refuse` is set,
 * `run` ran and failed with an error result, and `lookup` always succeeds.
 */
function makeBudgetToolSet({ refuse, runFails }: { refuse: boolean; runFails: boolean }): IToolSet {
  const toolSet = makeMockIMCPServer({
    name: 'workspace',
    preload: true,
    tools: [
      { name: 'create_event', description: 'Create a calendar event', inputSchema: OBJECT_INPUT_SCHEMA, preload: true },
      { name: 'lookup', description: 'Look something up', inputSchema: OBJECT_INPUT_SCHEMA, preload: true },
      { name: 'run', description: 'Run a command', inputSchema: OBJECT_INPUT_SCHEMA, preload: true },
    ],
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
  jest.mocked(toolSet.callTool).mockImplementation(params => {
    if (params.name === 'create_event' && refuse) {
      return Promise.reject(new ToolPolicyBlockedError(`Tool '${params.name}' is not allowed on MCP server workspace`));
    }
    if (params.name === 'run' && runFails) {
      return Promise.resolve(toolResultResponse({ text: 'Traceback: boom', isError: true }));
    }
    return Promise.resolve(toolResultResponse({ text: 'found' }));
  });
  return toolSet;
}

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

const lookupCall = (step: number) =>
  toolCallStream({ id: `lookup-${String(step)}`, name: 'lookup', args: { q: step } });

interface RunInput {
  toolSet: IToolSet;
  create: jest.Mock;
  threadId?: string;
  parent?: AgentParent | undefined;
  ledger?: TurnToolCallLedger | undefined;
}

async function runThread({
  toolSet,
  create,
  threadId = 'main',
  parent,
  ledger,
}: RunInput): Promise<{ events: unknown[]; thread: AgentThread }> {
  const modelClient: ILLM = { create, createNonStream: jest.fn() };
  const thread = new AgentThread({
    threadId,
    title: threadId,
    parent,
    toolCallMemo: undefined,
    turnToolCallLedger: ledger,
    isRequestContinuation: undefined,
    taskState: undefined,
    tracing: NOOP_AGENT_TRACING,
    logger: makeSilentLogger(),
    definition: {
      modelClient,
      modelId: undefined,
      configuredModels: undefined,
      instruction: 'test',
      toolSets: [toolSet],
    },
    context: [{ role: 'user', content: 'Plan my week' }],
  });
  const events: unknown[] = [];
  for await (const event of thread.execute({ signal: new AbortController().signal })) {
    events.push(event);
  }
  return { events, thread };
}

/** Requests after the first one whose tool list is sent: the model asked with tools until its budget ran out. */
function scriptedModel(
  steps: (step: number) => ReturnType<typeof toolCallStream> | ReturnType<typeof finalAnswerStream>,
) {
  const requests: LLMCreateParamsStreaming[] = [];
  const create = jest.fn((request: LLMCreateParamsStreaming) => {
    requests.push(request);
    return steps(requests.length);
  });
  return { create, requests };
}

const doneEvents = (events: unknown[]) =>
  events.filter(event => JSON.stringify(event).includes('"internal.agent.done"'));

describe('reply step budget', () => {
  it('a refused create_event is never retried, and the reply ends cleanly', async () => {
    const toolSet = makeBudgetToolSet({ refuse: true, runFails: false });
    const createEvent = (id: string) =>
      toolCallStream({ id, name: 'create_event', args: { title: 'Lunch', start: '12:00' } });
    const model = scriptedModel(step => {
      if (step === 1) return createEvent('create-1');
      // The model tries the same declined call again; it must not reach the tool.
      if (step === 2) return createEvent('create-2');
      return finalAnswerStream();
    });

    const { events, thread } = await runThread({ toolSet, create: model.create });

    expect(toolSet.callTool).toHaveBeenCalledTimes(1);
    expect(model.requests[1]?.tools?.map(tool => tool.type === 'function' && tool.function.name)).not.toContain(
      'create_event',
    );
    expect(JSON.stringify(model.requests[1]?.messages)).toContain('The person declined create event');
    expect(JSON.stringify(model.requests[2]?.messages)).toContain(REMOVED_TOOL_RESULT);
    expect(thread.turnToolCallLedger.removedTools).toEqual(['create_event']);
    const done = doneEvents(events);
    expect(done).toHaveLength(1);
    expect(JSON.stringify(done)).toContain('"status":"done"');
    expect(JSON.stringify(done)).toContain('Not finished: a step failed.');
  });

  it('two calls to removed tools in a row force the answer with no tools', async () => {
    const toolSet = makeBudgetToolSet({ refuse: true, runFails: false });
    const createEvent = (id: string) => toolCallStream({ id, name: 'create_event', args: { title: 'Lunch' } });
    const model = scriptedModel(step => (step <= 3 ? createEvent(`create-${String(step)}`) : finalAnswerStream()));

    const { events } = await runThread({ toolSet, create: model.create });

    expect(toolSet.callTool).toHaveBeenCalledTimes(1);
    expect(model.requests[3]?.tools).toBeUndefined();
    expect(JSON.stringify(model.requests[3]?.messages)).toContain(REMOVED_TOOL_STREAK_MESSAGE);
    expect(JSON.stringify(doneEvents(events))).toContain('"status":"done"');
  });

  it('the 9th main-thread step forces a final answer with no tools', async () => {
    const toolSet = makeBudgetToolSet({ refuse: false, runFails: false });
    const model = scriptedModel(step => (step <= 8 ? lookupCall(step) : finalAnswerStream()));

    const { events } = await runThread({ toolSet, create: model.create });

    expect(model.requests).toHaveLength(9);
    for (const request of model.requests.slice(0, 8)) {
      expect(request.tools).toBeDefined();
    }
    expect(model.requests[8]?.tools).toBeUndefined();
    expect(JSON.stringify(model.requests[8]?.messages)).toContain(STEP_BUDGET_SPENT_MESSAGE);
    expect(toolSet.callTool).toHaveBeenCalledTimes(8);
    expect(JSON.stringify(doneEvents(events))).toContain('"status":"done"');
  });

  it('a call written on the forced answer is dropped, not run', async () => {
    const toolSet = makeBudgetToolSet({ refuse: false, runFails: false });
    const model = scriptedModel(step => (step <= 8 ? lookupCall(step) : lookupCall(step)));

    const { events } = await runThread({ toolSet, create: model.create });

    expect(model.requests).toHaveLength(9);
    expect(toolSet.callTool).toHaveBeenCalledTimes(8);
    expect(JSON.stringify(doneEvents(events))).toContain('"status":"done"');
  });

  it("a sub-agent's 5th step forces its answer", async () => {
    const toolSet = makeBudgetToolSet({ refuse: false, runFails: false });
    const model = scriptedModel(step => (step <= 4 ? lookupCall(step) : finalAnswerStream()));

    const { thread } = await runThread({
      toolSet,
      create: model.create,
      threadId: 'sub-1',
      parent: { thread_id: 'main', tool_call_id: 'spawn-1' },
      ledger: createTurnToolCallLedger(),
    });

    expect(model.requests).toHaveLength(5);
    expect(model.requests[3]?.tools).toBeDefined();
    expect(model.requests[4]?.tools).toBeUndefined();
    expect(JSON.stringify(model.requests[4]?.messages)).toContain(STEP_BUDGET_SPENT_MESSAGE);
    expect(thread.turnToolCallLedger.stepsByThread.get('sub-1')).toBe(5);
  });

  it("budget counts across threads: a sub-agent's steps are recorded on the ledger the turn shares", async () => {
    const toolSet = makeBudgetToolSet({ refuse: false, runFails: false });
    const shared = createTurnToolCallLedger();
    const model = scriptedModel(step => (step <= 2 ? lookupCall(step) : finalAnswerStream()));

    const { thread } = await runThread({
      toolSet,
      create: model.create,
      threadId: 'sub-2',
      parent: { thread_id: 'main', tool_call_id: 'spawn-2' },
      ledger: shared,
    });

    expect(thread.turnToolCallLedger).toBe(shared);
    expect(shared.stepsByThread.get('sub-2')).toBe(3);
    expect(shared.stepsByThread.has('main')).toBe(false);
  });

  it('an incomplete reply carries the Not finished notice', async () => {
    const toolSet = makeBudgetToolSet({ refuse: false, runFails: true });
    const model = scriptedModel(step =>
      step === 1
        ? toolCallStream({ id: 'run-1', name: 'run', args: { command: 'python3 a.py' } })
        : finalAnswerStream(),
    );

    const { events } = await runThread({ toolSet, create: model.create });

    expect(JSON.stringify(doneEvents(events))).toContain('Not finished: a step failed.');
  });

  it('a retryable error gets one retry, then becomes final', async () => {
    const toolSet = makeBudgetToolSet({ refuse: false, runFails: true });
    const run = (id: string) => toolCallStream({ id, name: 'run', args: { command: 'python3 a.py' } });
    const model = scriptedModel(step => (step <= 3 ? run(`run-${String(step)}`) : finalAnswerStream()));

    const { thread } = await runThread({ toolSet, create: model.create });

    // The first failure is retried once; the second failure is final, so the third identical call is not run.
    expect(toolSet.callTool).toHaveBeenCalledTimes(2);
    const [record] = [...thread.turnToolCallLedger.callSignatures.values()];
    expect(record).toEqual(expect.objectContaining({ lastKind: 'error_final', retried: true }));
    expect(model.requests).toHaveLength(3);
  });

  it('a removed tool call is rejected before dispatch as error_final', async () => {
    const toolSet = makeBudgetToolSet({ refuse: true, runFails: false });
    const createEvent = (id: string) => toolCallStream({ id, name: 'create_event', args: { title: 'Lunch' } });
    const model = scriptedModel(step => (step <= 2 ? createEvent(`create-${String(step)}`) : finalAnswerStream()));

    await runThread({ toolSet, create: model.create });

    expect(toolSet.callTool).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(model.requests[2]?.messages)).toContain(REMOVED_TOOL_RESULT);
  });
});

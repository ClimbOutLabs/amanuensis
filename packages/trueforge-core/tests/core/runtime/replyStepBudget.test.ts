import { ToolPolicyBlockedError } from '../../../src/core/errors';
import type { ILLM, LLMCreateParamsStreaming } from '../../../src/core/llm/ILLM';
import type { ExtendedChatCompletionChunk, RawAssistantMessageWithUsage } from '../../../src/core/llm/LLMTypes';
import { getEmptyUsage } from '../../../src/core/llm/LLMTypes';
import { UNBACKED_CLAIM_NOTES } from '../../../src/core/llm/replyNotices';
import { createTurnToolCallLedger, type TurnToolCallLedger } from '../../../src/core/mcp/executeToolCalls';
import { toolResultResponse, type IToolSet } from '../../../src/core/mcp/IMCPServer';
import { AgentThread } from '../../../src/core/runtime/AgentThread';
import type { AgentParent } from '../../../src/core/runtime/AgentThread.types';
import {
  MAX_PROGRESS_STEP_REFUNDS,
  REMOVED_TOOL_RESULT,
  REMOVED_TOOL_STREAK_MESSAGE,
  STEP_BUDGET_SPENT_MESSAGE,
  unfinishedNotice,
} from '../../../src/core/runtime/replyBudget';
import { EDIT_SPACE_TOOL_NAME } from '../../../src/core/spaces/toolContract';
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
      {
        name: EDIT_SPACE_TOOL_NAME,
        description: 'Change a space',
        inputSchema: OBJECT_INPUT_SCHEMA,
        preload: true,
      },
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
    if (params.name === EDIT_SPACE_TOOL_NAME && params.arguments?.['refused'] === true) {
      return Promise.resolve(toolResultResponse({ text: 'Not saved.', isError: true }));
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

/** A sentence as it reads inside a JSON-encoded event, so quotes in it match. */
const escaped = (sentence: string) => JSON.stringify(sentence).slice(1, -1);

/** A tool removed from the reply before the thread starts, as a decline earlier in the turn would leave it. */
function ledgerWithRemoved(...tools: string[]): TurnToolCallLedger {
  const ledger = createTurnToolCallLedger();
  ledger.removedTools.push(...tools);
  return ledger;
}

describe('reply step budget', () => {
  it('a call the tool policy refuses is blocked, not declined: the tool stays for the next call', async () => {
    const toolSet = makeBudgetToolSet({ refuse: true, runFails: false });
    const createEvent = (id: string, title: string) =>
      toolCallStream({ id, name: 'create_event', args: { title, start: '12:00' } });
    const model = scriptedModel(step => {
      if (step === 1) return createEvent('create-1', 'Lunch');
      if (step === 2) return createEvent('create-2', 'Dinner');
      // No words of its own, so the host line shows.
      return finalAnswerStream('');
    });

    const { events, thread } = await runThread({ toolSet, create: model.create });

    expect(toolSet.callTool).toHaveBeenCalledTimes(2);
    expect(model.requests[2]?.tools?.map(tool => tool.type === 'function' && tool.function.name)).toContain(
      'create_event',
    );
    expect(JSON.stringify(model.requests[2]?.messages)).not.toContain('declined');
    expect(thread.turnToolCallLedger.removedTools).toEqual([]);
    const done = doneEvents(events);
    expect(done).toHaveLength(1);
    expect(JSON.stringify(done)).toContain('"status":"done"');
    expect(JSON.stringify(done)).toContain(escaped(unfinishedNotice('blocked')));
  });

  it('two calls to removed tools in a row force the answer with no tools', async () => {
    const toolSet = makeBudgetToolSet({ refuse: false, runFails: false });
    const createEvent = (id: string) => toolCallStream({ id, name: 'create_event', args: { title: 'Lunch' } });
    const model = scriptedModel(step => (step <= 3 ? createEvent(`create-${String(step)}`) : finalAnswerStream()));

    const { events } = await runThread({
      toolSet,
      create: model.create,
      ledger: ledgerWithRemoved('create_event'),
    });

    expect(toolSet.callTool).not.toHaveBeenCalled();
    expect(model.requests[2]?.tools).toBeUndefined();
    expect(JSON.stringify(model.requests[2]?.messages)).toContain(REMOVED_TOOL_STREAK_MESSAGE);
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

  describe('space writes', () => {
    const editCall = ({ step, refused }: { step: number; refused: boolean }) =>
      toolCallStream({ id: `edit-${String(step)}`, name: EDIT_SPACE_TOOL_NAME, args: { n: step, refused } });

    it('a landed space write does not spend the step, so a build in parts runs past 8 steps', async () => {
      const toolSet = makeBudgetToolSet({ refuse: false, runFails: false });
      const model = scriptedModel(step => (step <= 10 ? editCall({ step, refused: false }) : finalAnswerStream()));

      const { thread } = await runThread({ toolSet, create: model.create });

      expect(model.requests).toHaveLength(11);
      expect(model.requests[9]?.tools).toBeDefined();
      expect(thread.turnToolCallLedger.stepsByThread.get('main')).toBe(1);
      expect(thread.turnToolCallLedger.progressRefundsByThread.get('main')).toBe(10);
    });

    it('stops refunding at the cap, so the reply is bounded at 8 plus the cap', async () => {
      const toolSet = makeBudgetToolSet({ refuse: false, runFails: false });
      const model = scriptedModel(step => editCall({ step, refused: false }));

      const { thread } = await runThread({ toolSet, create: model.create });

      expect(thread.turnToolCallLedger.progressRefundsByThread.get('main')).toBe(MAX_PROGRESS_STEP_REFUNDS);
      expect(model.requests).toHaveLength(8 + MAX_PROGRESS_STEP_REFUNDS + 1);
      expect(model.requests.at(-1)?.tools).toBeUndefined();
      expect(JSON.stringify(model.requests.at(-1)?.messages)).toContain('Say which space you changed');
    });

    it('a refused space write refunds nothing', async () => {
      const toolSet = makeBudgetToolSet({ refuse: false, runFails: false });
      const model = scriptedModel(step => {
        if (step > 8) {
          return finalAnswerStream();
        }
        // A lookup between refusals keeps the failed-batch stop from ending the reply first.
        return step % 2 === 0 ? lookupCall(step) : editCall({ step, refused: true });
      });

      const { thread } = await runThread({ toolSet, create: model.create });

      expect(model.requests).toHaveLength(9);
      expect(model.requests[8]?.tools).toBeUndefined();
      expect(thread.turnToolCallLedger.progressRefundsByThread.get('main')).toBeUndefined();
      expect(JSON.stringify(model.requests[8]?.messages)).not.toContain('Say which space you changed');
    });
  });

  it('a call written on the forced answer is dropped, not run, and is not streamed either', async () => {
    const toolSet = makeBudgetToolSet({ refuse: false, runFails: false });
    const model = scriptedModel(step => lookupCall(step));

    const { events } = await runThread({ toolSet, create: model.create });

    expect(model.requests).toHaveLength(9);
    expect(toolSet.callTool).toHaveBeenCalledTimes(8);
    expect(JSON.stringify(events)).not.toContain('\\"q\\":9');
    // The forced step wrote no text, so the plain sentence is the reply.
    expect(JSON.stringify(doneEvents(events))).toContain(escaped(unfinishedNotice('budget')));
  });

  it('a forced answer with no text and no tool call still ends with a visible reply', async () => {
    const toolSet = makeBudgetToolSet({ refuse: false, runFails: false });
    const model = scriptedModel(step => (step <= 8 ? lookupCall(step) : finalAnswerStream()));

    const { events } = await runThread({ toolSet, create: model.create });

    expect(JSON.stringify(doneEvents(events))).toContain('"status":"done"');
    expect(JSON.stringify(events)).not.toContain(escaped(unfinishedNotice('budget')));
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

  it('an incomplete reply with no words of its own carries the Not finished notice', async () => {
    const toolSet = makeBudgetToolSet({ refuse: false, runFails: true });
    const model = scriptedModel(step =>
      step === 1
        ? toolCallStream({ id: 'run-1', name: 'run', args: { command: 'python3 a.py' } })
        : finalAnswerStream(''),
    );

    const { events } = await runThread({ toolSet, create: model.create });

    expect(JSON.stringify(doneEvents(events))).toContain(escaped(unfinishedNotice('failed')));
  });

  it('an incomplete reply that says why in its own words gets no host line', async () => {
    const toolSet = makeBudgetToolSet({ refuse: false, runFails: true });
    const model = scriptedModel(step =>
      step === 1
        ? toolCallStream({ id: 'run-1', name: 'run', args: { command: 'python3 a.py' } })
        : finalAnswerStream('The script failed, so I could not finish. Want me to try again?'),
    );

    const { events } = await runThread({ toolSet, create: model.create });

    const done = JSON.stringify(doneEvents(events));
    expect(done).toContain('The script failed, so I could not finish. Want me to try again?');
    expect(done).not.toContain(escaped(unfinishedNotice('failed')));
  });

  it('a reply that claims a blocked step as done still gets the nothing-was-changed line', async () => {
    const toolSet = makeBudgetToolSet({ refuse: true, runFails: false });
    const model = scriptedModel(step =>
      step === 1
        ? toolCallStream({ id: 'c-1', name: 'create_event', args: { title: 'Lunch' } })
        : finalAnswerStream("I've created the event for you."),
    );

    const { events } = await runThread({ toolSet, create: model.create });

    expect(JSON.stringify(doneEvents(events))).toContain(escaped(UNBACKED_CLAIM_NOTES.change));
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

  it('a removed tool raises no approval card, and a call to it is rejected unrun as error_final', async () => {
    const toolSet = makeBudgetToolSet({ refuse: false, runFails: false });
    jest.mocked(toolSet.toolCallInfo).mockImplementation(params =>
      Promise.resolve({
        type: 'mcp',
        mcp_server_id: toolSet.id,
        mcp_server_name: toolSet.name,
        original_tool_name: params.name,
        is_approval_required: params.name === 'create_event',
      }),
    );
    const createEvent = (id: string) => toolCallStream({ id, name: 'create_event', args: { title: 'Lunch' } });
    const model = scriptedModel(step => (step === 1 ? createEvent('create-1') : finalAnswerStream()));

    const { events, thread } = await runThread({
      toolSet,
      create: model.create,
      ledger: ledgerWithRemoved('create_event'),
    });

    expect(toolSet.callTool).not.toHaveBeenCalled();
    expect(JSON.stringify(events)).not.toContain('"tool.approval_required"');
    expect(JSON.stringify(model.requests[1]?.messages)).toContain(REMOVED_TOOL_RESULT);
    expect(thread.turnToolCallLedger.removedTools).toEqual(['create_event']);
  });

  it('a rejected call to a tool already removed keeps the reason the reply did not finish', async () => {
    const toolSet = makeBudgetToolSet({ refuse: false, runFails: false });
    const ledger = ledgerWithRemoved('create_event');
    ledger.unfinishedByThread.set('main', 'declined');
    const createEvent = (id: string) => toolCallStream({ id, name: 'create_event', args: { title: 'Lunch' } });
    const model = scriptedModel(step => (step === 1 ? createEvent('create-1') : finalAnswerStream('')));

    const { events } = await runThread({ toolSet, create: model.create, ledger });

    expect(JSON.stringify(doneEvents(events))).toContain(escaped(unfinishedNotice('declined')));
  });

  it("a sub-agent's rejections do not change the main thread's tools", async () => {
    const toolSet = makeBudgetToolSet({ refuse: false, runFails: false });
    const shared = ledgerWithRemoved('create_event');
    const createEvent = (id: string) => toolCallStream({ id, name: 'create_event', args: { title: 'Lunch' } });
    const sub = scriptedModel(step => (step <= 3 ? createEvent(`sub-${String(step)}`) : finalAnswerStream()));
    await runThread({
      toolSet,
      create: sub.create,
      threadId: 'sub-3',
      parent: { thread_id: 'main', tool_call_id: 'spawn-3' },
      ledger: shared,
    });
    expect(sub.requests[2]?.tools).toBeUndefined();

    const main = scriptedModel(() => finalAnswerStream());
    await runThread({ toolSet, create: main.create, ledger: shared });

    expect(main.requests[0]?.tools).toBeDefined();
    expect(main.requests[0]?.tools?.map(tool => tool.type === 'function' && tool.function.name)).toContain('lookup');
  });

  it("a sub-agent's failed step is not the main thread's reason", async () => {
    const toolSet = makeBudgetToolSet({ refuse: false, runFails: true });
    const shared = createTurnToolCallLedger();
    const sub = scriptedModel(step =>
      step === 1
        ? toolCallStream({ id: 'run-1', name: 'run', args: { command: 'python3 a.py' } })
        : finalAnswerStream(),
    );
    await runThread({
      toolSet,
      create: sub.create,
      threadId: 'sub-4',
      parent: { thread_id: 'main', tool_call_id: 'spawn-4' },
      ledger: shared,
    });
    expect(shared.unfinishedByThread.get('sub-4')).toBe('failed');

    const main = scriptedModel(() => finalAnswerStream());
    const { events } = await runThread({ toolSet, create: main.create, ledger: shared });

    expect(shared.unfinishedByThread.has('main')).toBe(false);
    expect(JSON.stringify(doneEvents(events))).not.toContain(escaped(unfinishedNotice('failed')));
  });
});

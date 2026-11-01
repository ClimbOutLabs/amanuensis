/**
 * The repeat guard lets a read repeat a few times in a row (a morning brief lists calendars and
 * searches events more than once) and keeps the tighter limit for anything that writes or sends.
 */
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import type { ILLM, LLMCreateParamsStreaming } from '../../../src/core/llm/ILLM';
import type {
  ExtendedChatCompletionChunk,
  RawAssistantMessageWithUsage,
  RawToolCall,
} from '../../../src/core/llm/LLMTypes';
import { getEmptyUsage } from '../../../src/core/llm/LLMTypes';
import { REPEAT_STOP_NOTE } from '../../../src/core/llm/replyNotices';
import { toolResultResponse } from '../../../src/core/mcp/IMCPServer';
import { REPEAT_LIMIT_OTHER_TOOLS, REPEAT_LIMIT_READ_TOOLS } from '../../../src/core/mcp/executeToolCalls';
import { AgentThread } from '../../../src/core/runtime/AgentThread';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { isRecord } from '../../../src/core/util/records';
import { finalAnswerStream, makeMockIMCPServer, makeSilentLogger } from '../harnessMocks';

const READ_TOOL = 'list_calendars';
const WRITE_TOOL = 'create_event';

function makeToolSet() {
  const toolSet = makeMockIMCPServer({
    name: 'google_calendar',
    preload: true,
    tools: [
      {
        name: READ_TOOL,
        description: 'List calendars',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
        preload: true,
      },
      {
        name: WRITE_TOOL,
        description: 'Add an event',
        inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
        preload: true,
      },
    ],
  });
  jest.mocked(toolSet.toolCallInfo).mockImplementation((params: CallToolRequest['params']) =>
    Promise.resolve({
      type: 'mcp',
      mcp_server_id: toolSet.id,
      mcp_server_name: toolSet.name,
      original_tool_name: params.name,
      is_approval_required: false,
      ...(params.name === READ_TOOL ? { read_only_hint: true } : { tier: 3 as const }),
    }),
  );
  jest.mocked(toolSet.callTool).mockImplementation(() => Promise.resolve(toolResultResponse({ text: '{"ok":true}' })));
  return toolSet;
}

type Call = { name: string; args: Record<string, unknown> };

function rawCall({ call, id }: { call: Call; id: string }): RawToolCall {
  return { id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } };
}

// eslint-disable-next-line @typescript-eslint/require-await -- async generator fixture, not awaiting I/O
async function* callsStream(
  calls: RawToolCall[],
): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  yield {
    id: 'chunk-calls',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test-model',
    choices: [
      {
        index: 0,
        delta: { role: 'assistant', tool_calls: calls.map((call, index) => ({ index, ...call })) },
        finish_reason: null,
      },
    ],
  };
  return {
    output: { role: 'assistant', content: null, tool_calls: calls },
    usage: getEmptyUsage(),
    finish_reason: 'tool_calls',
  };
}

/** Each step sends the next group of calls; after the last group the model answers. */
function scriptedModel(steps: Call[][]): ILLM['create'] {
  let round = 0;
  return jest.fn((_request: LLMCreateParamsStreaming) => {
    const step = steps[round];
    round += 1;
    return step === undefined
      ? finalAnswerStream()
      : callsStream(step.map((call, index) => rawCall({ call, id: `call-${String(round)}-${String(index)}` })));
  });
}

async function runTurn(steps: Call[][]) {
  const toolSet = makeToolSet();
  const create = scriptedModel(steps);
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
      modelClient: { create, createNonStream: jest.fn() },
      modelId: undefined,
      configuredModels: undefined,
      instruction: 'test',
      toolSets: [toolSet],
    },
    context: [{ role: 'user', content: 'Give me my morning brief.' }],
  });
  const events: unknown[] = [];
  for await (const event of thread.execute({ signal: new AbortController().signal })) {
    events.push(event);
  }
  const stopped = events.some(event => isRecord(event) && event['error'] === REPEAT_STOP_NOTE);
  return { stopped, modelSteps: jest.mocked(create).mock.calls.length };
}

function repeated({ call, times }: { call: Call; times: number }): Call[][] {
  return Array.from({ length: times }, () => [call]);
}

describe('repeat guard for reads', () => {
  const list: Call = { name: READ_TOOL, args: { query: 'work' } };
  const create: Call = { name: WRITE_TOOL, args: { title: 'Dentist' } };

  it('names a limit of three for reads and one for everything else', () => {
    expect(REPEAT_LIMIT_READ_TOOLS).toBe(3);
    expect(REPEAT_LIMIT_OTHER_TOOLS).toBe(1);
  });

  it('continues when a read repeats with identical arguments in three consecutive steps', async () => {
    const { stopped, modelSteps } = await runTurn(repeated({ call: list, times: REPEAT_LIMIT_READ_TOOLS }));
    expect(stopped).toBe(false);
    expect(modelSteps).toBe(REPEAT_LIMIT_READ_TOOLS + 1);
  });

  it('stops with the existing message on the fourth identical read', async () => {
    const { stopped, modelSteps } = await runTurn(repeated({ call: list, times: REPEAT_LIMIT_READ_TOOLS + 1 }));
    expect(stopped).toBe(true);
    expect(modelSteps).toBe(REPEAT_LIMIT_READ_TOOLS + 1);
  });

  it('still stops a write repeated straight after itself at the old threshold', async () => {
    const { stopped, modelSteps } = await runTurn(repeated({ call: create, times: REPEAT_LIMIT_OTHER_TOOLS + 1 }));
    expect(stopped).toBe(true);
    expect(modelSteps).toBe(REPEAT_LIMIT_OTHER_TOOLS + 1);
  });

  it('never counts a read repeated with different arguments', async () => {
    const steps = Array.from({ length: 8 }, (_, index) => [{ name: READ_TOOL, args: { query: `q${String(index)}` } }]);
    const { stopped } = await runTurn(steps);
    expect(stopped).toBe(false);
  });

  it('counts a read written twice in one step as one call', async () => {
    const { stopped } = await runTurn(
      repeated({ call: list, times: REPEAT_LIMIT_READ_TOOLS - 1 }).map(() => [list, list]),
    );
    expect(stopped).toBe(false);
  });
});

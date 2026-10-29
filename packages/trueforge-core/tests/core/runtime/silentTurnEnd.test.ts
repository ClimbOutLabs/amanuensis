import type { ILLM, LLMCreateParamsStreaming } from '../../../src/core/llm/ILLM';
import type { ExtendedChatCompletionChunk, RawAssistantMessageWithUsage } from '../../../src/core/llm/LLMTypes';
import { getEmptyUsage } from '../../../src/core/llm/LLMTypes';
import { toolResultResponse, type IToolSet } from '../../../src/core/mcp/IMCPServer';
import { AgentThread } from '../../../src/core/runtime/AgentThread';
import type { AgentThreadEvent } from '../../../src/core/runtime/AgentThread.types';
import { InternalEventType } from '../../../src/core/runtime/AgentThread.types';
import { REPEATED_ACTION_OWNER_MESSAGE } from '../../../src/core/runtime/replyActionChecks';
import { EMPTY_AFTER_TOOLS_MESSAGE } from '../../../src/core/runtime/replyBudget';
import { silentTurnEndLine } from '../../../src/core/runtime/silentTurnEnd';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { finalAnswerStream, makeMockIMCPServer, makeSilentLogger, OBJECT_INPUT_SCHEMA } from '../harnessMocks';

type ModelStream = AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown>;

// eslint-disable-next-line @typescript-eslint/require-await -- async generator fixture, not awaiting I/O
async function* emptyStream(): ModelStream {
  yield {
    id: 'chunk-empty',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test-model',
    choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: 'stop' }],
  };
  return { output: { role: 'assistant', content: null }, usage: getEmptyUsage(), finish_reason: 'stop' };
}

// eslint-disable-next-line @typescript-eslint/require-await -- async generator fixture, not awaiting I/O
async function* callsStream(calls: { id: string; args: object }[]): ModelStream {
  const toolCalls = calls.map(call => ({
    id: call.id,
    type: 'function' as const,
    function: { name: 'save_draft', arguments: JSON.stringify(call.args) },
  }));
  yield {
    id: 'chunk-calls',
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

function makeDraftToolSet(): IToolSet {
  const toolSet = makeMockIMCPServer({
    name: 'workspace',
    preload: true,
    tools: [{ name: 'save_draft', description: 'Save a draft', inputSchema: OBJECT_INPUT_SCHEMA, preload: true }],
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
  jest.mocked(toolSet.callTool).mockResolvedValue(toolResultResponse({ text: 'saved' }));
  return toolSet;
}

const DRAFT = { recipients: ['wendy@example.com'], subject: 'Hi' };
const OTHER_DRAFT = { recipients: ['sam@example.com'], subject: 'Hi' };

/** Runs one turn: the scripted steps in order. Any step past the script fails the test. */
async function runTurn(steps: (() => ModelStream)[]): Promise<{
  requests: LLMCreateParamsStreaming[];
  events: AgentThreadEvent[];
  text: string;
}> {
  const requests: LLMCreateParamsStreaming[] = [];
  const create = jest.fn((request: LLMCreateParamsStreaming) => {
    requests.push(request);
    const step = steps[requests.length - 1];
    if (step === undefined) {
      throw new Error('The model was asked for more steps than the test scripted.');
    }
    return step();
  });
  const modelClient: ILLM = { create, createNonStream: jest.fn() };
  const thread = new AgentThread({
    threadId: 'main',
    title: 'Main',
    toolCallMemo: undefined,
    turnToolCallLedger: undefined,
    isRequestContinuation: undefined,
    taskState: undefined,
    tracing: NOOP_AGENT_TRACING,
    logger: makeSilentLogger(),
    definition: {
      modelClient,
      modelId: undefined,
      configuredModels: undefined,
      instruction: 'test',
      toolSets: [makeDraftToolSet()],
    },
    context: [{ role: 'user', content: 'Save a draft to Wendy' }],
  });
  const events: AgentThreadEvent[] = [];
  let text = '';
  for await (const event of thread.execute({ signal: new AbortController().signal })) {
    events.push(event);
    if (event.type === InternalEventType.AGENT_DONE && event.status === 'done') {
      const content = event.output.content;
      text = typeof content === 'string' ? content : '';
    }
  }
  return { requests, events, text };
}

describe('a turn never ends silently after tool calls', () => {
  it('asks once for a no-tools answer when the step after a tool call is empty', async () => {
    const { requests, text } = await runTurn([
      () => callsStream([{ id: 'a', args: DRAFT }]),
      () => emptyStream(),
      () => finalAnswerStream('I saved the draft. Nothing was sent.'),
    ]);

    expect(requests).toHaveLength(3);
    expect(requests[1]?.tools).not.toBeUndefined();
    expect(requests[2]?.tools).toBeUndefined();
    expect(JSON.stringify(requests[2]?.messages)).toContain(EMPTY_AFTER_TOOLS_MESSAGE);
    expect(text).toBe('I saved the draft. Nothing was sent.');
  });

  it('writes a line from the tool outcomes when the answer step is empty too', async () => {
    const { requests, text } = await runTurn([
      () => callsStream([{ id: 'a', args: DRAFT }]),
      () => emptyStream(),
      () => emptyStream(),
    ]);

    expect(requests).toHaveLength(3);
    expect(text).toBe('Saved the draft to wendy@example.com. Nothing was sent.');
  });

  it('tells the person why a repeated call was skipped, and still ends with words', async () => {
    const { events, text } = await runTurn([
      () => callsStream([{ id: 'a', args: DRAFT }]),
      () => callsStream([{ id: 'b', args: OTHER_DRAFT }]),
      () => callsStream([{ id: 'c', args: DRAFT }]),
      () => emptyStream(),
      () => emptyStream(),
    ]);

    expect(JSON.stringify(events)).toContain(REPEATED_ACTION_OWNER_MESSAGE);
    expect(text).not.toBe('');
  });

  it('keeps a normal reply with text as it is', async () => {
    const { requests, text } = await runTurn([
      () => callsStream([{ id: 'a', args: DRAFT }]),
      () => finalAnswerStream('Done. Nothing was sent.'),
    ]);

    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests)).not.toContain(EMPTY_AFTER_TOOLS_MESSAGE);
    expect(text).toBe('Done. Nothing was sent.');
  });
});

describe('silentTurnEndLine', () => {
  const draft = JSON.stringify(DRAFT);

  it('leaves out a skipped repeat of a call that already worked', () => {
    expect(
      silentTurnEndLine([
        { toolName: 'save_draft', args: draft, disposition: 'executed_ok' },
        { toolName: 'save_draft', args: draft, disposition: 'never_ran' },
      ]),
    ).toBe('Saved the draft to wendy@example.com. Nothing was sent.');
  });

  it('names at most three recipients, skips entries with no readable address, and counts the rest', () => {
    const args = JSON.stringify({
      recipients: [
        'a@example.com',
        { email: 'b@example.com' },
        { name: 'Nobody' },
        7,
        { address: 'c@example.com' },
        'd@example.com',
        'e@example.com',
      ],
    });
    const line = silentTurnEndLine([{ toolName: 'save_draft', args, disposition: 'executed_ok' }]);
    expect(line).toBe('Saved the draft to a@example.com, b@example.com, c@example.com and 2 more. Nothing was sent.');
    expect(line).not.toContain('Nobody');
  });

  it('says in plain words when a step did not happen', () => {
    expect(
      silentTurnEndLine([
        { toolName: 'send_email', args: '{}', disposition: 'denied' },
        { toolName: 'list_calendar', args: '{}', disposition: 'executed_nonzero' },
      ]),
    ).toBe('Skipped, as you asked: send email. This step failed: list calendar.');
  });
});

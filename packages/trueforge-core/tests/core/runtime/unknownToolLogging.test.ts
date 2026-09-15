import type { ILLM } from '../../../src/core/llm/ILLM';
import { AgentThread } from '../../../src/core/runtime/AgentThread';
import { makeUnknownToolInfo, toToolCallInfo } from '../../../src/core/runtime/contextUtils';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { finalAnswerStream, makeSilentLogger, unknownToolStream } from '../harnessMocks';

const silentLogger = makeSilentLogger();
const warn = jest.spyOn(silentLogger, 'warn');

const UNKNOWN_TOOL_NAME = 'totally_unknown_tool';

describe('AgentThread unknown tool logging', () => {
  beforeEach(() => {
    warn.mockClear();
  });

  it('warns once with the canonical message and emits unknown tool_info', async () => {
    const modelClient: ILLM = {
      create: jest
        .fn()
        .mockImplementationOnce(() => unknownToolStream({ toolName: UNKNOWN_TOOL_NAME, callId: 'call-unknown' }))
        .mockImplementation(() => finalAnswerStream()),
      createNonStream: jest.fn(),
    };

    const thread = new AgentThread({
      threadId: 'main',
      title: 'Main',
      toolCallMemo: undefined,
      taskState: undefined,
      isRequestContinuation: undefined,
      tracing: NOOP_AGENT_TRACING,
      logger: silentLogger,
      definition: {
        modelId: undefined,
        configuredModels: undefined,
        modelClient,
        instruction: 'test',
        toolSets: [],
      },
      context: [{ role: 'user', content: 'hi' }],
    });

    const deltas: { tool_calls?: { tool_info?: unknown }[] | undefined }[] = [];
    for await (const event of thread.execute({ signal: new AbortController().signal })) {
      if (event.type === 'model.message.delta') {
        deltas.push(event);
      }
    }

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('LLM called unknown tool: Tool totally_unknown_tool not found in tool mapping.');

    const unknownInfo = toToolCallInfo(makeUnknownToolInfo(UNKNOWN_TOOL_NAME));
    const emitted = deltas.flatMap(d => d.tool_calls ?? []).find(tc => tc.tool_info);
    expect(emitted?.tool_info).toEqual(unknownInfo);
  });

  it('stops after the model repeats the same unavailable tool', async () => {
    // The repeated-unavailable-tool guard now routes through the shared bounded-recovery path
    // (recoverFromLoopOrExit): its first firing in a turn only appends a corrective note and lets
    // the turn continue, so the model gets one more chance before a second repeat actually stops
    // the turn with loop_detected. That's three model calls, not two.
    const create = jest
      .fn()
      .mockImplementationOnce(() => unknownToolStream({ toolName: UNKNOWN_TOOL_NAME, callId: 'call-unknown-1' }))
      .mockImplementationOnce(() => unknownToolStream({ toolName: UNKNOWN_TOOL_NAME, callId: 'call-unknown-2' }))
      .mockImplementationOnce(() => unknownToolStream({ toolName: UNKNOWN_TOOL_NAME, callId: 'call-unknown-3' }))
      .mockImplementation(() => finalAnswerStream());
    const modelClient: ILLM = { create, createNonStream: jest.fn() };

    const thread = new AgentThread({
      threadId: 'main',
      title: 'Main',
      toolCallMemo: undefined,
      taskState: undefined,
      isRequestContinuation: undefined,
      tracing: NOOP_AGENT_TRACING,
      logger: silentLogger,
      definition: {
        modelId: undefined,
        configuredModels: undefined,
        modelClient,
        instruction: 'test',
        toolSets: [],
      },
      context: [{ role: 'user', content: 'hi' }],
    });

    const events = [];
    for await (const event of thread.execute({ signal: new AbortController().signal })) {
      events.push(event);
    }

    expect(create).toHaveBeenCalledTimes(3);
    const correctiveResult = events.find(
      event => event.type === 'tool.response.v2' && event.tool_call_id === 'call-unknown-1',
    );
    expect(correctiveResult).toMatchObject({
      disposition: 'never_ran',
      remediation: { reason_code: 'unknown_tool', suggested_action: 'change_strategy' },
    });
    if (correctiveResult?.type !== 'tool.response.v2') {
      throw new Error('Expected a versioned tool response');
    }
    expect(correctiveResult.content).toContain('Tool totally_unknown_tool is unavailable in this conversation');
    expect(events.at(-1)).toMatchObject({
      status: 'error',
      error:
        'The model repeated unavailable tool totally_unknown_tool after receiving a corrective result, so the turn was stopped.',
    });
  });
});

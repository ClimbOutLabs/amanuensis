import { ASK_USER_QUESTION_TOOL_NAME, askUserQuestion } from '../../../src/core/capabilities/builtins/AskUserQuestion';
import { EventType } from '../../../src/core/events/schema';
import type { ILLM, LLMCreateParamsStreaming } from '../../../src/core/llm/ILLM';
import type { ExtendedChatCompletionChunk, RawAssistantMessageWithUsage } from '../../../src/core/llm/LLMTypes';
import { getEmptyUsage } from '../../../src/core/llm/LLMTypes';
import { AgentThread } from '../../../src/core/runtime/AgentThread';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { makeSilentLogger } from '../harnessMocks';

async function* questionStream(
  toolName: string,
): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  const call = {
    id: 'question-1',
    type: 'function' as const,
    function: {
      name: toolName,
      arguments: JSON.stringify({ question: 'Proceed?', options: ['Yes', 'No'] }),
    },
  };
  yield {
    id: 'question-chunk',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test-model',
    choices: [
      {
        index: 0,
        delta: { role: 'assistant', tool_calls: [{ index: 0, ...call }] },
        finish_reason: null,
      },
    ],
  };
  return {
    output: { role: 'assistant', content: null, tool_calls: [call] },
    usage: getEmptyUsage(),
    finish_reason: 'tool_calls',
  };
}

async function* finalAnswerStream(): AsyncGenerator<
  ExtendedChatCompletionChunk,
  RawAssistantMessageWithUsage,
  unknown
> {
  yield {
    id: 'answer-chunk',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test-model',
    choices: [{ index: 0, delta: { role: 'assistant', content: 'Continuing.' }, finish_reason: null }],
  };
  return {
    output: { role: 'assistant', content: 'Continuing.' },
    usage: getEmptyUsage(),
    finish_reason: 'stop',
  };
}

describe('clarification budget', () => {
  it('withholds ask_user_question after its answer within the same request', async () => {
    const requests: LLMCreateParamsStreaming[] = [];
    const create = jest.fn((params: LLMCreateParamsStreaming) => {
      requests.push(params);
      const questionTool = params.tools?.find(
        tool => tool.type === 'function' && tool.function.name.endsWith(ASK_USER_QUESTION_TOOL_NAME),
      );
      return requests.length === 1 && questionTool !== undefined
        ? questionStream(questionTool.type === 'function' ? questionTool.function.name : '')
        : finalAnswerStream();
    });
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
      definition: { modelClient, modelId: undefined, configuredModels: undefined, instruction: 'test', toolSets: [] },
      context: [{ role: 'user', content: 'Complete the requested work.' }],
      capabilities: [askUserQuestion()],
    });

    for await (const _event of thread.execute({ signal: new AbortController().signal })) {
      // Consume the first execution until it pauses for the client-side answer.
    }
    const clientResponseEvents = [];
    for await (const event of thread.send([
      {
        type: 'user.tool_response',
        thread_id: 'main',
        tool_call_id: 'question-1',
        content: 'Yes, proceed.',
      },
    ])) {
      clientResponseEvents.push(event);
    }
    const clientTerminalResults = clientResponseEvents.flatMap(event => event.output);
    expect(clientTerminalResults).toHaveLength(1);
    expect(clientTerminalResults[0]).toMatchObject({
      type: EventType.TOOL_RESPONSE_V2,
      tool_call_id: 'question-1',
      disposition: 'executed_ok',
      admission_provenance: { source: 'internal' },
    });
    expect(clientResponseEvents[0]?.context[0]).toMatchObject({ role: 'tool', tool_call_id: 'question-1' });
    expect(clientResponseEvents[0]?.context[0]).toHaveProperty(
      'content',
      expect.stringContaining('"disposition":"executed_ok"'),
    );
    const resumed = new AgentThread({
      threadId: 'main',
      title: 'Main',
      toolCallMemo: undefined,
      turnToolCallLedger: undefined,
      taskState: undefined,
      isRequestContinuation: undefined,
      tracing: NOOP_AGENT_TRACING,
      logger: makeSilentLogger(),
      definition: { modelClient, modelId: undefined, configuredModels: undefined, instruction: 'test', toolSets: [] },
      context: thread.toSnapshot().context,
      capabilities: [askUserQuestion()],
    });
    for await (const _event of resumed.execute({ signal: new AbortController().signal })) {
      // Consume the resumed execution.
    }

    expect(requests).toHaveLength(2);
    expect(
      requests[0]?.tools?.some(
        tool => tool.type === 'function' && tool.function.name.endsWith(ASK_USER_QUESTION_TOOL_NAME),
      ),
    ).toBe(true);
    expect(
      requests[1]?.tools?.some(
        tool => tool.type === 'function' && tool.function.name.endsWith(ASK_USER_QUESTION_TOOL_NAME),
      ) ?? false,
    ).toBe(false);
  });
});

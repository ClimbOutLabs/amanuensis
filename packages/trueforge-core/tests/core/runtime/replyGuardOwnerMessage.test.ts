import type { ILLM, LLMCreateParamsStreaming } from '../../../src/core/llm/ILLM';
import type { ExtendedChatCompletionChunk, RawAssistantMessageWithUsage } from '../../../src/core/llm/LLMTypes';
import { getEmptyUsage } from '../../../src/core/llm/LLMTypes';
import { toolResultResponse } from '../../../src/core/mcp/IMCPServer';
import { AgentThread } from '../../../src/core/runtime/AgentThread';
import { REPLY_CALL_NOT_RUN_OWNER_MESSAGE } from '../../../src/core/runtime/modelReplyGuard';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { finalAnswerStream, makeMockIMCPServer, makeSilentLogger, OBJECT_INPUT_SCHEMA } from '../harnessMocks';

// eslint-disable-next-line @typescript-eslint/require-await -- async generator fixture, not awaiting I/O
async function* callWithCutOffArguments(): AsyncGenerator<
  ExtendedChatCompletionChunk,
  RawAssistantMessageWithUsage,
  unknown
> {
  const call = {
    id: 'call_cut',
    type: 'function' as const,
    function: { name: 'update_space', arguments: '{"name":"Garden plan","body":"- [ ] Plant tomatoes' },
  };
  yield {
    id: 'chunk-cut',
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

describe('a call the reply guard stops', () => {
  it('tells the model how to retry and the person only a plain line', async () => {
    const toolSet = makeMockIMCPServer({
      name: 'spaces',
      preload: true,
      tools: [{ name: 'update_space', description: 'Update', inputSchema: OBJECT_INPUT_SCHEMA, preload: true }],
    });
    jest.mocked(toolSet.toolCallInfo).mockResolvedValue({
      type: 'mcp',
      mcp_server_id: toolSet.id,
      mcp_server_name: toolSet.name,
      original_tool_name: 'update_space',
      is_approval_required: false,
    });
    jest.mocked(toolSet.callTool).mockResolvedValue(toolResultResponse({ text: 'ok' }));
    const requests: LLMCreateParamsStreaming[] = [];
    const create = jest.fn((request: LLMCreateParamsStreaming) => {
      requests.push(request);
      return requests.length === 1 ? callWithCutOffArguments() : finalAnswerStream('Nothing changed.');
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
      definition: {
        modelClient,
        modelId: undefined,
        configuredModels: undefined,
        instruction: 'test',
        toolSets: [toolSet],
      },
      context: [{ role: 'user', content: 'Update my garden plan space.' }],
    });
    const events: unknown[] = [];
    for await (const event of thread.execute({ signal: new AbortController().signal })) {
      events.push(event);
    }

    // The call never ran.
    expect(toolSet.callTool).not.toHaveBeenCalled();
    // The model's next request carries its own instruction, unchanged.
    const retryText = JSON.stringify(requests[1]?.messages);
    expect(retryText).toContain('The update_space call was not sent because its arguments were not complete');
    expect(retryText).toContain('Send the whole call again, with all of its arguments finished.');
    // The person's line is plain: no tool name, no word about arguments.
    expect(REPLY_CALL_NOT_RUN_OWNER_MESSAGE).not.toMatch(/update_space|argument/i);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool.response.v2',
        tool_call_id: 'call_cut',
        remediation: expect.objectContaining({
          message: REPLY_CALL_NOT_RUN_OWNER_MESSAGE,
          suggested_action: 'contact_user',
        }),
      }),
    );
  });
});

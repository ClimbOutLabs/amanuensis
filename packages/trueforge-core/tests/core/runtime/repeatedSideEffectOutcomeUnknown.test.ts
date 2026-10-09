import type { ILLM, LLMCreateParamsStreaming } from '../../../src/core/llm/ILLM';
import type { ExtendedChatCompletionChunk, RawAssistantMessageWithUsage } from '../../../src/core/llm/LLMTypes';
import { getEmptyUsage } from '../../../src/core/llm/LLMTypes';
import { toolResultResponse, type IToolSet } from '../../../src/core/mcp/IMCPServer';
import { AgentThread } from '../../../src/core/runtime/AgentThread';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { finalAnswerStream, makeMockIMCPServer, makeSilentLogger, OBJECT_INPUT_SCHEMA } from '../harnessMocks';

/**
 * Reproduces the reported sequence: a side-effecting call whose first attempt
 * threw with its outcome never observed (a dropped connection, not a
 * definite success or failure), followed by an identical retry. The retry
 * must still be refused (its terminal state really is unknown), but the
 * refusal is an ordinary failed tool result the model can read and respond
 * to, not a fatal end to the turn.
 */
function makeWriteToolSet(): IToolSet {
  const toolSet = makeMockIMCPServer({
    name: 'workspace',
    preload: true,
    tools: [{ name: 'write_file', description: 'Write a file', inputSchema: OBJECT_INPUT_SCHEMA, preload: true }],
  });
  jest.mocked(toolSet.toolCallInfo).mockImplementation(params =>
    Promise.resolve({
      type: 'truefoundry-system',
      mcp_server_id: toolSet.id,
      mcp_server_name: toolSet.name,
      original_tool_name: params.name,
      is_approval_required: false,
    }),
  );
  jest
    .mocked(toolSet.callTool)
    .mockRejectedValueOnce(new Error('sandbox connection dropped mid-dispatch'))
    .mockResolvedValue(toolResultResponse({ text: 'ok' }));
  return toolSet;
}

// eslint-disable-next-line @typescript-eslint/require-await -- async generator fixture, not awaiting I/O
async function* writeCallStream(
  callId: string,
): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  const call = {
    id: callId,
    type: 'function' as const,
    function: { name: 'write_file', arguments: JSON.stringify({ path: 'smoke.md', content: 'hello' }) },
  };
  yield {
    id: `chunk-${callId}`,
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

describe('repeated side effect with a genuinely unknown outcome', () => {
  it('refuses the identical retry as an ordinary tool failure and lets the turn continue', async () => {
    const toolSet = makeWriteToolSet();
    const requests: LLMCreateParamsStreaming[] = [];
    let round = 0;
    const create = jest.fn((request: LLMCreateParamsStreaming) => {
      requests.push(request);
      round += 1;
      if (round === 1) return writeCallStream('write-1');
      if (round === 2) return writeCallStream('write-2');
      return finalAnswerStream();
    });
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
        modelId: undefined,
        configuredModels: undefined,
        modelClient,
        instruction: 'test',
        toolSets: [toolSet],
      },
      context: [{ role: 'user', content: 'Write smoke.md.' }],
    });

    const events: unknown[] = [];
    for await (const event of thread.execute({ signal: new AbortController().signal })) {
      events.push(event);
    }

    // The identical retry was refused before it dispatched a second time.
    expect(toolSet.callTool).toHaveBeenCalledTimes(1);
    // No fatal turn error anywhere in the run: the refusal is a tool result, not a stop.
    expect(events).not.toContainEqual(expect.objectContaining({ status: 'error' }));
    expect(events.at(-1)).toMatchObject({ type: 'internal.agent.done', status: 'done' });
    // The model actually saw the refusal text in the next request it made.
    expect(JSON.stringify(requests[2]?.messages)).toContain('already attempted');
  });
});

import { EventType } from '../../../src/core/events/schema';
import type { ILLM } from '../../../src/core/llm/ILLM';
import type { ExtendedChatCompletionChunk, RawAssistantMessageWithUsage } from '../../../src/core/llm/LLMTypes';
import { getEmptyUsage } from '../../../src/core/llm/LLMTypes';
import { AgentThread } from '../../../src/core/runtime/AgentThread';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { makeMockIMCPServer, makeSilentLogger } from '../harnessMocks';

function replyWith(
  calls: { id: string; title: string }[],
): () => AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  const toolCalls = calls.map(call => ({
    id: call.id,
    type: 'function' as const,
    function: { name: 'create_event', arguments: JSON.stringify({ summary: call.title }) },
  }));
  return async function* stream() {
    yield {
      id: 'chunk-1',
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
  };
}

describe('calendar changes in one turn', () => {
  it('asks for at most five and refuses the rest without a card', async () => {
    const toolSet = makeMockIMCPServer({
      name: 'Calendar',
      preload: true,
      tools: [
        {
          name: 'create_event',
          description: 'Adds an event.',
          inputSchema: { type: 'object', properties: { summary: { type: 'string' } } },
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
        is_approval_required: true,
        tier: 3,
        tier_reason: 'caldav_calendar_change',
        approval_token_id: `token-${JSON.stringify(params.arguments)}`,
      }),
    );
    const calls = Array.from({ length: 7 }, (_, index) => ({
      id: `call-${String(index)}`,
      title: `Event ${String(index)}`,
    }));
    const modelClient: ILLM = { create: jest.fn(replyWith(calls)), createNonStream: jest.fn() };
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
      },
      context: [{ role: 'user', content: 'add seven events' }],
    });
    let asked: string[] | undefined;
    for await (const event of thread.execute({ signal: new AbortController().signal })) {
      if (event.type === EventType.TOOL_APPROVAL_REQUIRED) {
        asked = event.tool_calls.map(call => call.id);
      }
    }
    expect(asked).toEqual(['call-0', 'call-1', 'call-2', 'call-3', 'call-4']);
    expect(toolSet.callTool).not.toHaveBeenCalled();
  });
});

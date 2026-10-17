import { EventType } from '../../../src/core/events/schema';
import type { ILLM } from '../../../src/core/llm/ILLM';
import type { ExtendedChatCompletionChunk, RawAssistantMessageWithUsage } from '../../../src/core/llm/LLMTypes';
import { getEmptyUsage } from '../../../src/core/llm/LLMTypes';
import { AgentThread } from '../../../src/core/runtime/AgentThread';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { makeMockIMCPServer, makeSilentLogger } from '../harnessMocks';

async function* toolCallStream(): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  const call = { id: 'call-1', type: 'function' as const, function: { name: 'tool_a', arguments: '{}' } };
  yield {
    id: 'chunk-1',
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

/** Runs one attended turn whose only tool call waits for approval, and returns that call's `can_chat_allow`. */
async function canChatAllow(tierReason: string): Promise<boolean | undefined> {
  const toolSet = makeMockIMCPServer({ name: 'notes', preload: true });
  jest.mocked(toolSet.toolCallInfo).mockResolvedValue({
    type: 'mcp',
    mcp_server_id: toolSet.id,
    mcp_server_name: toolSet.name,
    original_tool_name: 'tool_a',
    is_approval_required: true,
    effect: 'inspect',
    tier: 3,
    tier_reason: tierReason,
  });
  const modelClient: ILLM = { create: jest.fn(() => toolCallStream()), createNonStream: jest.fn() };
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
    context: [{ role: 'user', content: 'call the tool' }],
  });
  for await (const event of thread.execute({ signal: new AbortController().signal })) {
    if (event.type === EventType.TOOL_APPROVAL_REQUIRED) {
      return event.tool_calls[0]?.can_chat_allow;
    }
  }
  throw new Error('expected a tool.approval_required event');
}

describe('the approval event says whether chat scope is offered', () => {
  it('offers it for a plain read and withholds it for a send', async () => {
    expect(await canChatAllow('unrecognized_tool')).toBe(true);
    expect(await canChatAllow('connector_send')).toBe(false);
  });
});

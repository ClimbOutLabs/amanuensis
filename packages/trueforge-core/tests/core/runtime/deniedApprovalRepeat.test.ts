import { EventType } from '../../../src/core/events/schema';
import type { ILLM } from '../../../src/core/llm/ILLM';
import type {
  ExtendedChatCompletionChunk,
  InternalToolCallInfo,
  RawAssistantMessageWithUsage,
} from '../../../src/core/llm/LLMTypes';
import { getEmptyUsage } from '../../../src/core/llm/LLMTypes';
import { approvalExpiredReason } from '../../../src/core/permissions/approvalExpiry';
import { changeRequestReason } from '../../../src/core/permissions/changeRequest';
import { AgentThread } from '../../../src/core/runtime/AgentThread';
import { InternalEventType, type AgentThreadEvent } from '../../../src/core/runtime/AgentThread.types';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { makeMockIMCPServer, makeSilentLogger } from '../harnessMocks';

type ModelStep = { kind: 'call'; id: string; name: 'web_search' | 'save_draft'; args: object } | { kind: 'text' };

function stream(step: ModelStep): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  return (async function* () {
    if (step.kind === 'text') {
      yield {
        id: 'text-chunk',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'test-model',
        choices: [{ index: 0, delta: { role: 'assistant', content: 'Here is what I know.' }, finish_reason: null }],
      };
      return {
        output: { role: 'assistant', content: 'Here is what I know.' },
        usage: getEmptyUsage(),
        finish_reason: 'stop',
      };
    }
    const call = {
      id: step.id,
      type: 'function' as const,
      function: { name: step.name, arguments: JSON.stringify(step.args) },
    };
    yield {
      id: `${step.id}-chunk`,
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
  })();
}

function search(id: string, query: string): ModelStep {
  return { kind: 'call', id, name: 'web_search', args: { query } };
}

/** The card a search or a draft carries: the search card never names the query, so every search shares one identity. */
function card(destination: string): InternalToolCallInfo['tier3_card'] {
  return {
    plain_what: 'Do the thing.',
    plain_why: null,
    cannot_be_undone: null,
    why_asked_again: null,
    destination,
    recipient: null,
    amount: null,
    parsed_command: null,
    outbound_text: null,
    destination_host: null,
    outbound_truncated: false,
  };
}

function makeThread(steps: ModelStep[]) {
  const toolSet = makeMockIMCPServer({
    name: 'web',
    preload: true,
    tools: [
      { name: 'web_search', description: 'Search', inputSchema: { type: 'object' }, preload: true },
      { name: 'save_draft', description: 'Draft', inputSchema: { type: 'object' }, preload: true },
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
      tier3_card: card(params.name === 'web_search' ? 'search' : 'drafts'),
    }),
  );
  const queue = [...steps];
  const modelClient: ILLM = {
    create: jest.fn(() => {
      const next = queue.shift();
      if (next === undefined) {
        throw new Error('the model was called more often than the test expects');
      }
      return stream(next);
    }),
    createNonStream: jest.fn(),
  };
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
    context: [{ role: 'user', content: 'Tell me about my week.' }],
  });
  return { thread, toolSet };
}

async function run(thread: AgentThread): Promise<AgentThreadEvent[]> {
  const events: AgentThreadEvent[] = [];
  for await (const event of thread.execute({ signal: new AbortController().signal })) {
    events.push(event);
  }
  return events;
}

async function answer(input: { thread: AgentThread; toolCallId: string; reason: string }): Promise<void> {
  for await (const event of input.thread.send([
    {
      type: EventType.USER_TOOL_APPROVAL,
      thread_id: 'main',
      tool_call_id: input.toolCallId,
      approval: { status: 'deny', reason: input.reason },
    },
  ])) {
    void event;
  }
}

function cardIds(events: AgentThreadEvent[]): string[] {
  return events.flatMap(event =>
    event.type === EventType.TOOL_APPROVAL_REQUIRED ? event.tool_calls.map(call => call.id) : [],
  );
}

function results(events: AgentThreadEvent[]) {
  return events.flatMap(event => (event.type === EventType.TOOL_RESPONSE_V2 ? [event] : []));
}

describe('a "no" to a search holds for the rest of the turn', () => {
  it('shows no new card when the model rewords a denied search, and ends the turn', async () => {
    const { thread, toolSet } = makeThread([
      search('search-1', 'Dana Example'),
      search('search-2', 'Dana Example biography'),
      search('search-3', 'who is Dana Example'),
    ]);
    expect(cardIds(await run(thread))).toEqual(['search-1']);

    await answer({ thread, toolCallId: 'search-1', reason: 'No thanks' });
    const after = await run(thread);

    expect(cardIds(after)).toEqual([]);
    expect(thread.isAwaitingUserInput()).toBe(false);
    expect(toolSet.callTool).not.toHaveBeenCalled();
    const repeats = results(after).filter(result => result.tool_call_id !== 'search-1');
    expect(repeats.map(result => result.tool_call_id)).toEqual(['search-2', 'search-3']);
    for (const result of repeats) {
      expect(result.disposition).toBe('denied');
      expect(JSON.stringify(result.content)).toContain('Do not try it again');
    }
  });

  it('still asks after a card that expired, and stops only after a real no', async () => {
    const { thread } = makeThread([
      search('search-1', 'weather this weekend'),
      search('search-2', 'weekend weather forecast'),
      search('search-3', 'forecast for Saturday'),
      { kind: 'text' },
    ]);
    await run(thread);

    await answer({ thread, toolCallId: 'search-1', reason: approvalExpiredReason() });
    expect(cardIds(await run(thread))).toEqual(['search-2']);

    await answer({ thread, toolCallId: 'search-2', reason: 'No thanks' });
    const after = await run(thread);
    expect(cardIds(after)).toEqual([]);
    expect(results(after).find(result => result.tool_call_id === 'search-3')?.disposition).toBe('denied');
  });

  it('still asks after a "Change it" answer, and stops only after a real no', async () => {
    const { thread } = makeThread([
      search('search-1', 'restaurants nearby'),
      search('search-2', 'quiet restaurants nearby'),
      search('search-3', 'calm places to eat'),
      { kind: 'text' },
    ]);
    await run(thread);

    await answer({ thread, toolCallId: 'search-1', reason: changeRequestReason('only quiet places') });
    expect(cardIds(await run(thread))).toEqual(['search-2']);

    await answer({ thread, toolCallId: 'search-2', reason: 'No thanks' });
    expect(cardIds(await run(thread))).toEqual([]);
  });

  it('lets a new message through when the turn stopped right after a repeat of a no was saved', async () => {
    const { thread, toolSet } = makeThread([
      search('search-1', 'Dana Example'),
      search('search-2', 'Dana Example biography'),
      { kind: 'text' },
    ]);
    await run(thread);
    await answer({ thread, toolCallId: 'search-1', reason: 'No thanks' });

    // Stop the turn on the save that holds the repeat, before it is refused.
    const controller = new AbortController();
    try {
      for await (const event of thread.execute({ signal: controller.signal })) {
        if (
          event.type === InternalEventType.AGENT_CONTEXT_APPEND &&
          event.context.some(message => 'tool_calls' in message && message.tool_calls?.[0]?.id === 'search-2')
        ) {
          controller.abort();
        }
      }
    } catch {
      // A stopped turn may end by throwing; the saved state is what matters here.
    }
    expect(thread.hasOpenToolCallId('search-2')).toBe(true);

    for await (const event of thread.send([
      { type: EventType.USER_MESSAGE, content: 'Never mind, what is on today?' },
    ])) {
      void event;
    }

    expect(thread.hasOpenToolCallId('search-2')).toBe(false);
    const closed = thread
      .toSnapshot()
      .context.find(message => 'role' in message && message.role === 'tool' && message.tool_call_id === 'search-2');
    expect(JSON.stringify(closed)).toContain('\\"disposition\\":\\"denied\\"');
    expect(JSON.stringify(closed)).toContain('Do not try it again');
    expect(toolSet.callTool).not.toHaveBeenCalled();
  });

  it('does not let a no to a different kind of action block a search', async () => {
    const { thread } = makeThread([
      { kind: 'call', id: 'draft-1', name: 'save_draft', args: { body: 'Hello' } },
      search('search-1', 'train times'),
      search('search-2', 'train timetable'),
      { kind: 'text' },
    ]);
    expect(cardIds(await run(thread))).toEqual(['draft-1']);

    await answer({ thread, toolCallId: 'draft-1', reason: 'No thanks' });
    expect(cardIds(await run(thread))).toEqual(['search-1']);

    await answer({ thread, toolCallId: 'search-1', reason: 'No thanks' });
    const after = await run(thread);
    expect(cardIds(after)).toEqual([]);
    const repeat = results(after).find(result => result.tool_call_id === 'search-2');
    expect(repeat?.disposition).toBe('denied');
    expect(JSON.stringify(repeat?.content)).toContain('Do not try it again');
  });
});

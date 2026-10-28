import { EventType } from '../../../src/core/events/schema';
import type { ILLM } from '../../../src/core/llm/ILLM';
import type { ExtendedChatCompletionChunk, RawAssistantMessageWithUsage } from '../../../src/core/llm/LLMTypes';
import { getEmptyUsage } from '../../../src/core/llm/LLMTypes';
import { createTurnToolCallLedger } from '../../../src/core/mcp/executeToolCalls';
import { AgentThread } from '../../../src/core/runtime/AgentThread';
import type { ContextMessage } from '../../../src/core/runtime/AgentThread.types';
import { InternalEventType } from '../../../src/core/runtime/AgentThread.types';
import { EMPTY_ANSWER_NUDGE_MESSAGE, internalSystemMessage } from '../../../src/core/runtime/contextUtils';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { makeMockIMCPServer, makeSilentLogger, OBJECT_INPUT_SCHEMA } from '../harnessMocks';

const LINK = '/spaces/space_dogs';
const LINE = `I saved 2 changes to the space [Dog breeds](${LINK}).`;

// eslint-disable-next-line @typescript-eslint/require-await -- async generator fixture, not awaiting I/O
async function* replyStream(
  content: string | null,
): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  yield {
    id: 'chunk',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test-model',
    choices: [{ index: 0, delta: { role: 'assistant', content: content ?? '' }, finish_reason: null }],
  };
  return {
    output: { role: 'assistant', content, ...(content === null ? { reasoning_content: 'Thinking.' } : {}) },
    usage: getEmptyUsage(),
    finish_reason: 'stop',
  };
}

function writeHistory({
  user = 'Build a dog breeds page.',
  ids = ['c1', 'c2'],
  name = 'Dog breeds',
  result,
}: { user?: string; ids?: string[]; name?: string; result?: string } = {}): ContextMessage[] {
  const history: ContextMessage[] = [{ role: 'user', content: user }];
  for (const id of ids) {
    history.push(
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id,
            type: 'function',
            function: { name: 'edit_space', arguments: JSON.stringify({ space_name: name }) },
            tool_info: {
              type: 'mcp',
              mcp_server_id: 'space',
              mcp_server_name: 'space',
              original_tool_name: 'edit_space',
              is_approval_required: false,
              is_client_side: false,
            },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: id,
        content: result ?? JSON.stringify({ summary: 'Updated space.', space: { name, link: LINK } }),
      },
    );
  }
  return history;
}

async function runReply({
  replies,
  history = writeHistory(),
  budget = false,
  toolSets = [],
  parent,
}: {
  replies: (string | null)[];
  history?: ContextMessage[];
  budget?: boolean;
  toolSets?: ReturnType<typeof makeMockIMCPServer>[];
  parent?: { thread_id: string; tool_call_id: string };
}) {
  const create = jest.fn((): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> => {
    const reply = replies[Math.min(create.mock.calls.length - 1, replies.length - 1)];
    return replyStream(reply ?? '');
  });
  const modelClient: ILLM = { create, createNonStream: jest.fn() };
  const turnToolCallLedger = createTurnToolCallLedger();
  if (budget) {
    turnToolCallLedger.unfinishedByThread.set('main', 'budget');
  }
  const thread = new AgentThread({
    threadId: 'main',
    title: 'Main',
    toolCallMemo: undefined,
    turnToolCallLedger,
    taskState: undefined,
    isRequestContinuation: undefined,
    tracing: NOOP_AGENT_TRACING,
    logger: makeSilentLogger(),
    definition: { modelClient, modelId: undefined, configuredModels: undefined, instruction: 'test', toolSets },
    parent,
    context: history,
  });
  const finals: string[] = [];
  const deltas: string[] = [];
  const saved: unknown[] = [];
  for await (const event of thread.execute({ signal: new AbortController().signal })) {
    if (event.type === EventType.MODEL_MESSAGE_DELTA && typeof event.content === 'string') {
      deltas.push(event.content);
    }
    if (event.type === InternalEventType.AGENT_CONTEXT_APPEND) {
      for (const output of event.output) {
        if (output.type === EventType.MODEL_MESSAGE && typeof output.content === 'string') {
          finals.push(output.content);
        }
      }
      for (const message of event.context) {
        if ('role' in message && message.role === 'assistant') {
          saved.push(message.content);
        }
      }
    }
  }
  return { finals, deltas, saved };
}

describe('the closing line after space writes', () => {
  it('is added once, saved with the reply, when the reply does not name the space', async () => {
    const { finals, deltas, saved } = await runReply({ replies: ['All done.'] });
    expect(finals).toEqual([`All done.\n\n${LINE}`]);
    expect(deltas.join('')).not.toContain('I saved');
    expect(saved.filter(content => typeof content === 'string' && content.includes('I saved'))).toHaveLength(1);
  });

  it('leaves a reply that names the space alone', async () => {
    const { finals } = await runReply({ replies: ['The Dog breeds page now lists forty breeds.'] });
    expect(finals).toEqual(['The Dog breeds page now lists forty breeds.']);
  });

  it('changes nothing when no space was written', async () => {
    const { finals } = await runReply({ replies: ['All done.'], history: [{ role: 'user', content: 'Hello.' }] });
    expect(finals).toEqual(['All done.']);
  });

  it('puts the line after the host note on an empty answer', async () => {
    // The nudge already went out this turn, so a second silent reply gets the host's fixed note.
    const history = [...writeHistory(), internalSystemMessage(EMPTY_ANSWER_NUDGE_MESSAGE)];
    const { finals } = await runReply({ replies: [null], history });
    expect(finals).toEqual([`The model produced no answer.\n\n${LINE}`]);
  });

  it('adds the continue wording when the reply ended by the step budget', async () => {
    const { finals } = await runReply({ replies: ['Here is where I got to.'], budget: true });
    expect(finals.at(-1)).toContain('I stopped before the page was complete. Ask me to continue.');
  });

  it('is written once when the grounding nudge brings a second final answer', async () => {
    const searchTools = makeMockIMCPServer({
      name: 'web',
      preload: true,
      tools: [
        {
          name: 'web_search',
          description: 'Search the web',
          inputSchema: { ...OBJECT_INPUT_SCHEMA, properties: { query: { type: 'string' } }, required: ['query'] },
          preload: true,
        },
      ],
    });
    const history = writeHistory({ user: 'Make a space for my 2027 trip plan.', ids: ['c1'], name: 'Trip plan' });
    const { finals } = await runReply({ replies: ['Done.', 'Done, from memory.'], history, toolSets: [searchTools] });
    expect(finals.filter(content => content.includes('I saved'))).toHaveLength(1);
    expect(finals).toHaveLength(2);
  });

  it('adds nothing on a sub-agent thread', async () => {
    const { finals } = await runReply({ replies: ['All done.'], parent: { thread_id: 'root', tool_call_id: 'x' } });
    expect(finals).toEqual(['All done.']);
  });

  it('matches the space name in any letter case', async () => {
    const { finals } = await runReply({ replies: ['The DOG BREEDS page is ready.'] });
    expect(finals).toEqual(['The DOG BREEDS page is ready.']);
  });

  it('does not repeat the budget notice the reply already carries', async () => {
    const { finals } = await runReply({ replies: [null], budget: true });
    expect(finals.at(-1)).toContain('Stopped after many steps without finishing.');
    expect(finals.at(-1)).toContain('I saved 2 changes');
    expect(finals.at(-1)).not.toContain('Ask me to continue');
  });
});

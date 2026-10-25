/**
 * The details-off report: on long turns, an earlier turn's steps show even though agent details
 * are off. The owner's hypothesis: compaction during a long turn rewrites the earlier turns, and
 * the rebuilt turns render without their folded state.
 *
 * This test drives the real compaction path in a whole chat (session store, per-turn resolvers,
 * the model and a tool, as the server runs them): turn 1 uses a tool and answers; turn 2 runs
 * with a context already large enough that compaction fires inside it and rewrites turn 1 in the
 * model's context. It then compares everything the chat view is drawn from for turn 1 (its event
 * feed slice and its stored turn state) before and after the compaction.
 */
import type { ITurnResourceResolver } from '../../src/agent-session/ITurnResourceResolver';
import { Sessions } from '../../src/agent-session/Sessions';
import { MAIN_THREAD_ID } from '../../src/agent-session/models/TurnRecord';
import { EventType } from '../../src/agent-session/schemas/events';
import { InMemorySessionStore } from '../../src/agent-session/store/InMemorySessionStore';
import { CONVERSATION_REQUIRED_SUMMARY_SECTIONS } from '../../src/core/capabilities/builtins/ContextCompaction';
import type { ExtendedChatCompletionChunk, RawAssistantMessageWithUsage } from '../../src/core/llm/LLMTypes';
import type { ToolSource } from '../../src/core/mcp/IMCPServer';
import { toolResultResponse } from '../../src/core/mcp/IMCPServer';
import { ToolSet } from '../../src/core/mcp/ToolSet';
import type { AuditRecordInput } from '../../src/core/permissions/audit';
import { createSentinelHostContext, defaultSentinelServices } from '../../src/core/permissions/context';
import { makeAgentSpec, makeMockILLM, makeTestResolver, mintTestTurnId } from './testHelpers';

const OWNER = { subject_id: 'user-1', subject_type: 'user' as const, subject_display_name: 'user-1' };

/** A distinctive tool result, long enough that the compaction tail cannot keep it verbatim. */
const NOTE_TEXT = `Ada Lovelace wrote notes on the analytical engine. ${'The notes describe an algorithm for computing Bernoulli numbers. '.repeat(60)}`;

const SUMMARY = `<summary>\n${CONVERSATION_REQUIRED_SUMMARY_SECTIONS.map(name => `## ${name}\nnone`).join('\n\n')}\n</summary>`;

const usage = (inputTokens: number) => ({
  input_tokens: inputTokens,
  output_tokens: 20,
  total_tokens: inputTokens + 20,
});

// eslint-disable-next-line @typescript-eslint/require-await -- async generator fixture, not awaiting I/O
async function* lookupStream(): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  const call = {
    id: 'call-1',
    type: 'function' as const,
    function: { name: 'lookup', arguments: JSON.stringify({ query: 'Ada Lovelace notes' }) },
  };
  yield {
    id: 'chunk-call-1',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test-model',
    choices: [
      {
        index: 0,
        delta: { role: 'assistant', tool_calls: [{ index: 0, ...call }] },
        finish_reason: 'tool_calls',
      },
    ],
  };
  return {
    output: { role: 'assistant', content: null, tool_calls: [call] },
    usage: usage(10),
    finish_reason: 'tool_calls',
  };
}

// eslint-disable-next-line @typescript-eslint/require-await -- async generator fixture, not awaiting I/O
async function* answerStream(
  text: string,
  inputTokens: number,
): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  yield {
    id: `chunk-${text}`,
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test-model',
    choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: 'stop' }],
  };
  return {
    output: { role: 'assistant', content: text },
    usage: usage(inputTokens),
    finish_reason: 'stop',
  };
}

async function drain(turn: { stream(): AsyncIterable<unknown> }): Promise<void> {
  for await (const event of turn.stream()) {
    void event;
  }
}

describe('compaction during a later turn and the earlier turn the chat view draws', () => {
  it('rewrites the earlier turn in the model context but leaves its served events and state untouched', async () => {
    const audit: AuditRecordInput[] = [];
    const services = {
      ...defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
      searchWithoutAsking: () => Promise.resolve(true),
      audit: {
        record: (input: AuditRecordInput) => {
          audit.push(input);
          return Promise.resolve();
        },
      },
    };
    const callTool = jest.fn(() => Promise.resolve(toolResultResponse({ text: NOTE_TEXT })));
    const source: ToolSource = {
      name: 'finder',
      id: 'finder',
      listTools: () =>
        Promise.resolve({
          result: {
            tools: [
              {
                name: 'lookup',
                description: 'Looks things up on the web.',
                inputSchema: { type: 'object' as const, properties: {} },
                annotations: { readOnlyHint: true, openWorldHint: true },
                preload: true,
              },
            ],
          },
          wasInitialized: undefined,
        }),
      callTool,
      toolCallInfo: params =>
        Promise.resolve({
          type: 'mcp',
          mcp_server_id: 'finder',
          mcp_server_name: 'finder',
          original_tool_name: params.name,
        }),
    };
    const create = jest.fn();
    const createNonStream = jest
      .fn()
      .mockResolvedValue({ output: { role: 'assistant', content: SUMMARY }, usage: usage(30), finish_reason: 'stop' });
    const modelClient = makeMockILLM({ create, createNonStream });
    const resolverForTurn = (): ITurnResourceResolver => {
      const base = makeTestResolver({ modelClient });
      return {
        get logger() {
          return base.logger;
        },
        get webSearchTurn() {
          return base.webSearchTurn;
        },
        createTracing: () => base.createTracing(),
        resolveAgentSpec: input => base.resolveAgentSpec(input),
        resolveSandbox: input => base.resolveSandbox(input),
        resolveAgentDefinition: async input => {
          const resolved = await base.resolveAgentDefinition(input);
          const toolSet = new ToolSet({
            source,
            selectors: {
              enableTools: ['@all'],
              disableTools: [],
              preloadTools: [],
              requireApprovalForTools: undefined,
            },
            preload: true,
            sentinel: createSentinelHostContext({
              tenant_id: input.tenant_id,
              created_by: input.created_by,
              conversation_id: input.session_id,
              services: input.sentinel_services,
              web_search: base.webSearchTurn,
            }),
            searchProvider: { tools: [], plumbing_fields: [] },
          });
          return {
            ...resolved,
            extraCapabilities: [
              ...(resolved.extraCapabilities ?? []),
              {
                systemToolSets: [toolSet],
                preSendProcessors: undefined,
                preLLMProcessors: undefined,
                preLLMEphemeralProcessors: undefined,
                postToolCallProcessors: undefined,
                toolResponseProcessors: undefined,
                instructionBuilders: undefined,
              },
            ],
          };
        },
        close: () => base.close(),
      };
    };
    const store = new InMemorySessionStore();
    const sessions = new Sessions({ sessionStore: store, sentinelServices: services });
    await sessions.create({
      tenant_id: 't',
      session_id: 'details-off-compaction-chat',
      created_by_subject: OWNER,
      agent: {
        type: 'inline',
        spec: makeAgentSpec({
          config: {
            context_management: {
              compaction: { enabled: true, trigger: { type: 'input_tokens', value: 2000 } },
            },
          },
        }),
      },
      external_id: null,
      source: null,
    });
    const loadChat = async () => {
      const loaded = await sessions.get({ tenant_id: 't', session_id: 'details-off-compaction-chat' });
      if (loaded === undefined) {
        throw new Error('The test chat is missing.');
      }
      return loaded;
    };
    const run = async (content: string) => {
      const turn = await (
        await loadChat()
      ).createTurn({
        turn_id: mintTestTurnId(),
        input: [{ type: EventType.USER_MESSAGE, content }],
        signal: new AbortController().signal,
        resolver: resolverForTurn(),
      });
      await drain(turn);
      return turn;
    };
    const turnEvents = async (turnId: string) => {
      const { data } = await (await loadChat()).listEvents({ limit: 200 });
      return data.filter(item => item.turn_id === turnId);
    };

    // Turn 1: a tool call and its result, then the answer. The answer call reports a context
    // already past the compaction trigger, as a real long conversation would.
    create
      .mockImplementationOnce(() => lookupStream())
      .mockImplementationOnce(() => answerStream('Here is the first answer.', 6000));
    const turn1 = await run('first question');
    expect(callTool).toHaveBeenCalledTimes(1);

    const turn1EventsBefore: unknown = JSON.parse(JSON.stringify(await turnEvents(turn1.id)));
    const turn1StateBefore: unknown = JSON.parse(JSON.stringify((await (await loadChat()).getTurn(turn1.id))?.state));
    // Turn 1 really has steps the chat view folds when details are off.
    expect(JSON.stringify(turn1EventsBefore)).toContain('lookup');
    // Before any shortening, the stored model context really holds turn 1's tool result, so the
    // later check that it is gone proves the context was rewritten, not merely never written.
    const turn1Record = await store.getTurn({ session_id: 'details-off-compaction-chat', turn_id: turn1.id });
    const contextBefore = (turn1Record?.snapshot.threads[MAIN_THREAD_ID]?.context ?? [])
      .map(message => JSON.stringify(message))
      .join('\n');
    expect(contextBefore).toContain('Ada Lovelace wrote notes');

    // Turn 2: compaction fires inside it, before its first model call.
    create.mockImplementationOnce(() => answerStream('Here is the second answer.', 40));
    const turn2 = await run('second question');

    // Compaction really ran in turn 2 and applied.
    const turn2Events = await turnEvents(turn2.id);
    const compaction = turn2Events.find(item => item.event.type === EventType.AGENT_CONTEXT_COMPACTION);
    expect(compaction).toBeDefined();
    if (compaction?.event.type === EventType.AGENT_CONTEXT_COMPACTION) {
      expect(compaction.event.outcome).toBe('applied');
    }
    expect(createNonStream).toHaveBeenCalled();

    // The model context really was rewritten: turn 1's tool result is gone from it, replaced by
    // the summary; only the recent tail (the first answer, the new question) survives verbatim.
    const tip = await store.getTurn({ session_id: 'details-off-compaction-chat', turn_id: turn2.id });
    const context = tip?.snapshot.threads[MAIN_THREAD_ID]?.context ?? [];
    const contextText = context.map(message => JSON.stringify(message)).join('\n');
    expect(contextText).toContain('<summary>');
    expect(contextText).not.toContain('Ada Lovelace wrote notes');
    expect(contextText).toContain('Here is the first answer.');

    // The deciding comparison: everything the chat view is drawn from for turn 1 is unchanged.
    expect(JSON.parse(JSON.stringify(await turnEvents(turn1.id)))).toEqual(turn1EventsBefore);
    expect(JSON.parse(JSON.stringify((await (await loadChat()).getTurn(turn1.id))?.state))).toEqual(turn1StateBefore);
  });
});

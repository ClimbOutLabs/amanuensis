/**
 * The per-turn write cap and the identical-call rule hold for a whole request, across approval
 * pauses and across the root thread and a sub-agent. Each card is answered through a session
 * reopened from storage, so every resume rebuilds the turn's counts from what was saved.
 */
import type { ITurnResourceResolver } from '../../src/agent-session/ITurnResourceResolver';
import { MAIN_THREAD_ID } from '../../src/agent-session/models/TurnRecord';
import { EventType } from '../../src/agent-session/schemas/events';
import { Sessions } from '../../src/agent-session/Sessions';
import { InMemorySessionStore } from '../../src/agent-session/store/InMemorySessionStore';
import { dynamicSubAgents } from '../../src/core/capabilities/builtins/DynamicSubAgents';
import type { ExtendedChatCompletionChunk, RawAssistantMessageWithUsage } from '../../src/core/llm/LLMTypes';
import { getEmptyUsage } from '../../src/core/llm/LLMTypes';
import { MAX_WRITE_CALLS_PER_TURN } from '../../src/core/mcp/executeToolCalls';
import type { ToolSource } from '../../src/core/mcp/IMCPServer';
import { toolResultResponse } from '../../src/core/mcp/IMCPServer';
import { ToolSet } from '../../src/core/mcp/ToolSet';
import { createSentinelHostContext, defaultSentinelServices } from '../../src/core/permissions';
import { WRITE_CAP_STOP_MESSAGE } from '../../src/core/runtime/replyActionChecks';
import { makeAgentSpec, makeMockILLM, makeTestResolver, mintTestTurnId } from './testHelpers';

const OWNER = { subject_id: 'user-1', subject_type: 'user' as const, subject_display_name: 'user-1' };
const SUB_AGENT_ARGS = JSON.stringify({ name: 'mailer', input: 'send the remaining notes' });

function noteArgs(body: string): string {
  return JSON.stringify({ to: 'ana@example.com', body });
}

function toolCallStream(
  id: string,
  call: { name: string; args: string },
): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  const calls = [{ id, type: 'function' as const, function: { name: call.name, arguments: call.args } }];
  return (async function* () {
    yield {
      id: `chunk-${id}`,
      object: 'chat.completion.chunk',
      created: 0,
      model: 'test-model',
      choices: [
        {
          index: 0,
          delta: { role: 'assistant', tool_calls: calls.map((toolCall, index) => ({ index, ...toolCall })) },
          finish_reason: 'tool_calls',
        },
      ],
    };
    return {
      output: { role: 'assistant', content: null, tool_calls: calls },
      usage: getEmptyUsage(),
      finish_reason: 'tool_calls',
    };
  })();
}

function textStream(text: string): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  return (async function* () {
    yield {
      id: 'chunk-text',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'test-model',
      choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    };
    return { output: { role: 'assistant', content: text }, usage: getEmptyUsage(), finish_reason: 'stop' };
  })();
}

type Reply = { id: string; name: string; args: string } | { text: string };

/**
 * The root sends two notes, then starts a sub-agent. The sub-agent first repeats the root's last
 * note, then sends four new ones. Every send asks for approval, so the request pauses before each.
 */
const CAP_SCRIPT: Reply[] = [
  { id: 'root-1', name: 'send_note', args: noteArgs('Note 1') },
  { id: 'root-2', name: 'send_note', args: noteArgs('Note 2') },
  { id: 'root-sub', name: 'create_sub_agent', args: SUB_AGENT_ARGS },
  { id: 'sub-repeat', name: 'send_note', args: noteArgs('Note 2') },
  { id: 'sub-3', name: 'send_note', args: noteArgs('Note 3') },
  { id: 'sub-4', name: 'send_note', args: noteArgs('Note 4') },
  { id: 'sub-5', name: 'send_note', args: noteArgs('Note 5') },
  { id: 'sub-6', name: 'send_note', args: noteArgs('Note 6') },
];

function scriptedModel(script: Reply[]) {
  const create = jest.fn();
  for (const reply of script) {
    create.mockImplementationOnce(() => ('text' in reply ? textStream(reply.text) : toolCallStream(reply.id, reply)));
  }
  create.mockImplementation(() => textStream('Finished.'));
  return create;
}

async function setup({ cards, script }: { cards: boolean; script: Reply[] }) {
  const callTool = jest.fn(() => Promise.resolve(toolResultResponse({ text: 'sent' })));
  const source: ToolSource = {
    name: 'mail',
    id: 'mail',
    listTools: () =>
      Promise.resolve({
        result: {
          tools: [
            {
              name: 'send_note',
              description: 'Send a note',
              inputSchema: { type: 'object' as const, properties: {} },
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
        mcp_server_id: 'mail',
        mcp_server_name: 'mail',
        original_tool_name: params.name,
        // Without cards the send is still a write: it counts toward the cap but needs no approval.
        ...(cards ? {} : { is_approval_required: false, tier: 3 as const }),
      }),
  };
  const create = scriptedModel(script);
  const sentinelServices = defaultSentinelServices({ pinned_path: '/usr/bin:/bin' });
  const base = makeTestResolver({ modelClient: makeMockILLM({ create }) });
  const resolver: ITurnResourceResolver = {
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
        selectors: { enableTools: ['@all'], disableTools: [], preloadTools: [], requireApprovalForTools: undefined },
        preload: true,
        sentinel: createSentinelHostContext({
          tenant_id: input.tenant_id,
          created_by: input.created_by,
          conversation_id: input.session_id,
          services: input.sentinel_services,
        }),
      });
      return {
        ...resolved,
        extraCapabilities: [
          ...(resolved.extraCapabilities ?? []),
          dynamicSubAgents({ sandboxAvailable: false, tracing: base.createTracing() }),
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
  const store = new InMemorySessionStore();
  return { store, sentinelServices, resolver, callTool, create };
}

type Fixture = Awaited<ReturnType<typeof setup>>;
type StoredTurn = Awaited<ReturnType<Fixture['store']['getTurn']>>;

async function startTurn(fixture: Fixture) {
  const session = await new Sessions({
    sessionStore: fixture.store,
    sentinelServices: fixture.sentinelServices,
  }).create({
    tenant_id: 't',
    session_id: 'notes-chat',
    external_id: 'notes-chat-1',
    created_by_subject: OWNER,
    agent: { type: 'inline', spec: makeAgentSpec() },
  });
  const handle = await session.createTurn({
    turn_id: mintTestTurnId(),
    input: [{ type: EventType.USER_MESSAGE, content: 'Send Ana my notes' }],
    signal: new AbortController().signal,
    resolver: fixture.resolver,
  });
  for await (const event of handle.stream()) {
    void event;
  }
  return await fixture.store.getTurn({ session_id: 'notes-chat', turn_id: handle.id });
}

/** Approves the cards of a paused request once, through a session reopened from storage. */
async function approveOnce({ store, sentinelServices, resolver }: Fixture, paused: StoredTurn) {
  const pending = paused?.state.status === 'done' ? paused.state.required_actions : [];
  const cards = pending.filter(action => action.type === EventType.TOOL_APPROVAL_REQUIRED);
  if (cards.length === 0) {
    return undefined;
  }
  const reopened = await new Sessions({ sessionStore: store, sentinelServices }).get({
    tenant_id: 't',
    session_id: 'notes-chat',
  });
  const answer = await reopened?.createTurn({
    turn_id: mintTestTurnId(),
    input: cards.flatMap(card =>
      card.type === EventType.TOOL_APPROVAL_REQUIRED
        ? card.tool_calls.map(call => ({
            type: EventType.USER_TOOL_APPROVAL,
            thread_id: card.thread_id ?? '',
            tool_call_id: call.id,
            approval: { status: 'allow' as const },
          }))
        : [],
    ),
    previous_turn_id: paused?.id,
    signal: new AbortController().signal,
    resolver,
  });
  for await (const event of answer?.stream() ?? []) {
    void event;
  }
  return answer === undefined ? undefined : await store.getTurn({ session_id: 'notes-chat', turn_id: answer.id });
}

async function approveAll(fixture: Fixture, paused: StoredTurn) {
  let turn = paused;
  for (let resumes = 0; resumes < 20; resumes += 1) {
    const next = await approveOnce(fixture, turn);
    if (next === undefined) {
      return turn;
    }
    turn = next;
  }
  return turn;
}

describe('turn-wide tool limits across approval pauses in a full session', () => {
  it('refuses a repeat of the root call and the 6th send after resumes, and ends the request plainly', async () => {
    const fixture = await setup({ cards: true, script: CAP_SCRIPT });
    const turn = await approveAll(fixture, await startTurn(fixture));

    const sentBodies = fixture.callTool.mock.calls.map(call => JSON.stringify(call));
    expect(fixture.callTool).toHaveBeenCalledTimes(MAX_WRITE_CALLS_PER_TURN);
    expect(sentBodies.filter(body => body.includes('Note 2'))).toHaveLength(1);
    expect(sentBodies.some(body => body.includes('Note 6'))).toBe(false);
    expect(turn?.state).toMatchObject({ status: 'error', message: WRITE_CAP_STOP_MESSAGE });
    // The root is not asked to carry on after the sub-agent hit the cap.
    expect(fixture.create.mock.calls.length).toBe(CAP_SCRIPT.length);
  });

  it('ends the request when a sub-agent hits the cap in a turn with no pauses', async () => {
    const fixture = await setup({ cards: false, script: CAP_SCRIPT });
    const turn = await startTurn(fixture);

    expect(fixture.callTool).toHaveBeenCalledTimes(MAX_WRITE_CALLS_PER_TURN);
    expect(turn?.state).toMatchObject({ status: 'error', message: WRITE_CAP_STOP_MESSAGE });
    expect(fixture.create.mock.calls.length).toBe(CAP_SCRIPT.length);
  });

  it('keeps the counts of a sub-agent that finished before a later pause', async () => {
    // The sub-agent sends Note 1 and finishes. The root then sends Note 2, which pauses the request
    // again; the count saved at that pause must still hold the sub-agent's write.
    const fixture = await setup({
      cards: true,
      script: [
        { id: 'root-sub', name: 'create_sub_agent', args: SUB_AGENT_ARGS },
        { id: 'sub-1', name: 'send_note', args: noteArgs('Note 1') },
        { text: 'Note 1 is sent.' },
        { id: 'root-2', name: 'send_note', args: noteArgs('Note 2') },
      ],
    });
    const subAgentCard = await startTurn(fixture);
    const rootCard = await approveOnce(fixture, subAgentCard);
    const finished = await approveAll(fixture, rootCard);

    expect(rootCard?.snapshot.threads[MAIN_THREAD_ID]?.tool_call_memo?.write_calls_this_turn).toBe(1);
    expect(finished?.snapshot.threads[MAIN_THREAD_ID]?.tool_call_memo?.write_calls_this_turn).toBe(2);
    expect(fixture.callTool).toHaveBeenCalledTimes(2);
  });
});

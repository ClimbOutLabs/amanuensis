/**
 * The per-turn write cap and the identical-call rule hold for a whole request, across approval
 * pauses and across the root thread and a sub-agent. Each card is answered through a session
 * reopened from storage, so every resume rebuilds the turn's counts from what was saved.
 */
import type { ITurnResourceResolver } from '../../src/agent-session/ITurnResourceResolver';
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

/**
 * The root sends two notes, then starts a sub-agent. The sub-agent first repeats the root's last
 * note, then sends four new ones. Every send asks for approval, so the request pauses before each.
 */
function scriptedModel() {
  const create = jest.fn();
  const replies = [
    toolCallStream('root-1', { name: 'send_note', args: noteArgs('Note 1') }),
    toolCallStream('root-2', { name: 'send_note', args: noteArgs('Note 2') }),
    toolCallStream('root-sub', { name: 'create_sub_agent', args: SUB_AGENT_ARGS }),
    toolCallStream('sub-repeat', { name: 'send_note', args: noteArgs('Note 2') }),
    toolCallStream('sub-3', { name: 'send_note', args: noteArgs('Note 3') }),
    toolCallStream('sub-4', { name: 'send_note', args: noteArgs('Note 4') }),
    toolCallStream('sub-5', { name: 'send_note', args: noteArgs('Note 5') }),
    toolCallStream('sub-6', { name: 'send_note', args: noteArgs('Note 6') }),
  ];
  for (const reply of replies) {
    create.mockImplementationOnce(() => reply);
  }
  create.mockImplementation(() => textStream('Finished.'));
  return create;
}

async function setup({ cards }: { cards: boolean }) {
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
  const create = scriptedModel();
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

describe('turn-wide tool limits across approval pauses in a full session', () => {
  it('refuses a repeat of the root call and the 6th send after resumes, and ends the request plainly', async () => {
    const { store, sentinelServices, resolver, callTool, create } = await setup({ cards: true });
    const sessions = new Sessions({ sessionStore: store, sentinelServices });
    const session = await sessions.create({
      tenant_id: 't',
      session_id: 'notes-chat',
      external_id: 'notes-chat-1',
      created_by_subject: OWNER,
      agent: { type: 'inline', spec: makeAgentSpec() },
    });
    const first = await session.createTurn({
      turn_id: mintTestTurnId(),
      input: [{ type: EventType.USER_MESSAGE, content: 'Send Ana my notes' }],
      signal: new AbortController().signal,
      resolver,
    });
    for await (const event of first.stream()) {
      void event;
    }
    let turn = await session.getTurn(first.id);

    // Approve every card through a session reopened from storage, until the request ends.
    for (let resumes = 0; resumes < 20; resumes += 1) {
      const pending = turn?.state.status === 'done' ? turn.state.required_actions : [];
      const cards = pending.filter(action => action.type === EventType.TOOL_APPROVAL_REQUIRED);
      if (cards.length === 0) {
        break;
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
        previous_turn_id: turn?.id,
        signal: new AbortController().signal,
        resolver,
      });
      for await (const event of answer?.stream() ?? []) {
        void event;
      }
      turn = answer === undefined ? undefined : await reopened?.getTurn(answer.id);
    }

    const sentBodies = callTool.mock.calls.map(call => JSON.stringify(call));
    expect(callTool).toHaveBeenCalledTimes(MAX_WRITE_CALLS_PER_TURN);
    expect(sentBodies.filter(body => body.includes('Note 2'))).toHaveLength(1);
    expect(sentBodies.some(body => body.includes('Note 6'))).toBe(false);
    expect(turn?.state).toMatchObject({ status: 'error', message: WRITE_CAP_STOP_MESSAGE });
    // The root is not asked to carry on after the sub-agent hit the cap.
    expect(create.mock.calls.length).toBe(8);
  });

  it('ends the request when a sub-agent hits the cap in a turn with no pauses', async () => {
    const { store, sentinelServices, resolver, callTool, create } = await setup({ cards: false });
    const session = await new Sessions({ sessionStore: store, sentinelServices }).create({
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
      resolver,
    });
    for await (const event of handle.stream()) {
      void event;
    }
    const turn = await session.getTurn(handle.id);

    expect(callTool).toHaveBeenCalledTimes(MAX_WRITE_CALLS_PER_TURN);
    expect(turn?.state).toMatchObject({ status: 'error', message: WRITE_CAP_STOP_MESSAGE });
    expect(create.mock.calls.length).toBe(8);
  });
});

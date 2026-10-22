/**
 * A sub-agent that pauses for approval is stored with its turn. Reopening the session from the
 * store and answering the child's card must reach that child, for Approve and for Deny.
 */
import type { ITurnResourceResolver } from '../../src/agent-session/ITurnResourceResolver';
import { EventType } from '../../src/agent-session/schemas/events';
import { Sessions } from '../../src/agent-session/Sessions';
import { InMemorySessionStore } from '../../src/agent-session/store/InMemorySessionStore';
import { dynamicSubAgents } from '../../src/core/capabilities/builtins/DynamicSubAgents';
import type { ExtendedChatCompletionChunk, RawAssistantMessageWithUsage } from '../../src/core/llm/LLMTypes';
import { getEmptyUsage } from '../../src/core/llm/LLMTypes';
import type { ToolSource } from '../../src/core/mcp/IMCPServer';
import { toolResultResponse } from '../../src/core/mcp/IMCPServer';
import { ToolSet } from '../../src/core/mcp/ToolSet';
import { createSentinelHostContext, defaultSentinelServices } from '../../src/core/permissions';
import { makeAgentSpec, makeMockILLM, makeTestResolver, mintTestTurnId } from './testHelpers';

const SEND_ARGS = JSON.stringify({ to: 'ana@example.com', body: 'Lunch at noon?' });
const SUB_AGENT_ARGS = JSON.stringify({ name: 'mailer', input: 'send the lunch note' });
const OWNER = { subject_id: 'user-1', subject_type: 'user' as const, subject_display_name: 'user-1' };

function toolCallStream(
  id: string,
  toolCalls: Array<{ id: string; name: string; args: string }>,
): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  const calls = toolCalls.map(call => ({
    id: call.id,
    type: 'function' as const,
    function: { name: call.name, arguments: call.args },
  }));
  return (async function* () {
    yield {
      id,
      object: 'chat.completion.chunk',
      created: 0,
      model: 'test-model',
      choices: [
        {
          index: 0,
          delta: { role: 'assistant', tool_calls: calls.map((call, index) => ({ index, ...call })) },
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

/** Root delegates; the child asks to send mail (an approval); then both finish with text. */
async function setup() {
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
      }),
  };
  const create = jest.fn();
  create.mockImplementationOnce(() =>
    toolCallStream('chunk-subagent', [{ id: 'call-subagent', name: 'create_sub_agent', args: SUB_AGENT_ARGS }]),
  );
  create.mockImplementationOnce(() =>
    toolCallStream('chunk-send', [{ id: 'call-send', name: 'send_note', args: SEND_ARGS }]),
  );
  create.mockImplementation(() => textStream('Finished.'));

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
  const sessions = new Sessions({ sessionStore: store, sentinelServices });
  const session = await sessions.create({
    tenant_id: 't',
    session_id: 'helper-chat',
    external_id: 'helper-chat-1',
    created_by_subject: OWNER,
    agent: { type: 'inline', spec: makeAgentSpec() },
  });
  const turn = await session.createTurn({
    turn_id: mintTestTurnId(),
    input: [{ type: EventType.USER_MESSAGE, content: 'Send Ana the lunch note' }],
    signal: new AbortController().signal,
    resolver,
  });
  for await (const event of turn.stream()) {
    void event;
  }
  return { store, sentinelServices, resolver, callTool, create, paused: await session.getTurn(turn.id) };
}

describe('a sub-agent that paused for approval, after the session is reopened from storage', () => {
  it('accepts Approve for the child and runs its call once', async () => {
    const { store, sentinelServices, resolver, callTool, paused } = await setup();
    const pending = paused?.state.status === 'done' ? paused.state.required_actions : [];
    const child = pending.find(action => action.type === EventType.TOOL_APPROVAL_REQUIRED);
    expect(child?.thread_id).toBeTruthy();
    expect(callTool).not.toHaveBeenCalled();

    const reopened = await new Sessions({ sessionStore: store, sentinelServices }).get({
      tenant_id: 't',
      session_id: 'helper-chat',
    });
    expect(reopened).toBeDefined();
    const answer = await reopened?.createTurn({
      turn_id: mintTestTurnId(),
      input: [
        {
          type: EventType.USER_TOOL_APPROVAL,
          thread_id: child?.thread_id ?? '',
          tool_call_id: 'call-send',
          approval: { status: 'allow' },
        },
      ],
      previous_turn_id: paused?.id,
      signal: new AbortController().signal,
      resolver,
    });
    expect(answer).toBeDefined();
    for await (const event of answer?.stream() ?? []) {
      void event;
    }
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it('accepts Deny for the child and runs nothing', async () => {
    const { store, sentinelServices, resolver, callTool, paused } = await setup();
    const pending = paused?.state.status === 'done' ? paused.state.required_actions : [];
    const child = pending.find(action => action.type === EventType.TOOL_APPROVAL_REQUIRED);

    const reopened = await new Sessions({ sessionStore: store, sentinelServices }).get({
      tenant_id: 't',
      session_id: 'helper-chat',
    });
    const answer = await reopened?.createTurn({
      turn_id: mintTestTurnId(),
      input: [
        {
          type: EventType.USER_TOOL_APPROVAL,
          thread_id: child?.thread_id ?? '',
          tool_call_id: 'call-send',
          approval: { status: 'deny', reason: 'Not now' },
        },
      ],
      previous_turn_id: paused?.id,
      signal: new AbortController().signal,
      resolver,
    });
    expect(answer).toBeDefined();
    for await (const event of answer?.stream() ?? []) {
      void event;
    }
    expect(callTool).not.toHaveBeenCalled();
  });
});

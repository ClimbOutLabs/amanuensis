/**
 * "Always allow" is saved only once the decision that chose it has committed to the turn, and
 * only for the connector configuration the card was shown for.
 */
import type { ITurnResourceResolver } from '../../src/agent-session/ITurnResourceResolver';
import { EventType } from '../../src/agent-session/schemas/events';
import { Sessions } from '../../src/agent-session/Sessions';
import { InMemorySessionStore } from '../../src/agent-session/store/InMemorySessionStore';
import { StaleApprovalContinuationError } from '../../src/agent-session/store/SessionStoreErrors';
import type {
  ConnectorIdentity,
  ExtendedChatCompletionChunk,
  RawAssistantMessageWithUsage,
} from '../../src/core/llm/LLMTypes';
import { getEmptyUsage } from '../../src/core/llm/LLMTypes';
import type { ToolSource } from '../../src/core/mcp/IMCPServer';
import { toolResultResponse } from '../../src/core/mcp/IMCPServer';
import { ToolSet } from '../../src/core/mcp/ToolSet';
import {
  createSentinelHostContext,
  defaultSentinelServices,
  type SentinelServices,
  type ToolGrantKey,
} from '../../src/core/permissions';
import { InMemoryToolGrantStore } from '../../src/core/permissions/toolGrants';
import { makeAgentSpec, makeMockILLM, makeTestResolver, mintTestTurnId } from './testHelpers';

const OWNER = { subject_id: 'user-1', subject_type: 'user' as const, subject_display_name: 'user-1' };
const ORIGINAL: ConnectorIdentity = { id: 'srv_mail', fingerprint: 'fp-original' };
const REPOINTED: ConnectorIdentity = { id: 'srv_mail', fingerprint: 'fp-repointed' };

function grantKey(connector: ConnectorIdentity): ToolGrantKey {
  return { tenant_id: 't', created_by: OWNER.subject_id, mcp_server_name: 'mail', tool_name: 'read_note', connector };
}

// eslint-disable-next-line @typescript-eslint/require-await -- async generator fixture, not awaiting I/O
async function* readNoteStream(): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  const toolCalls = [{ id: 'call-read', type: 'function' as const, function: { name: 'read_note', arguments: '{}' } }];
  yield {
    id: 'chunk-read',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test-model',
    choices: [
      {
        index: 0,
        delta: { role: 'assistant', tool_calls: toolCalls.map((call, index) => ({ index, ...call })) },
        finish_reason: 'tool_calls',
      },
    ],
  };
  return {
    output: { role: 'assistant', content: null, tool_calls: toolCalls },
    usage: getEmptyUsage(),
    finish_reason: 'tool_calls',
  };
}

// eslint-disable-next-line @typescript-eslint/require-await -- async generator fixture, not awaiting I/O
async function* textStream(): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  yield {
    id: 'chunk-text',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test-model',
    choices: [{ index: 0, delta: { role: 'assistant', content: 'Done.' }, finish_reason: 'stop' }],
  };
  return { output: { role: 'assistant', content: 'Done.' }, usage: getEmptyUsage(), finish_reason: 'stop' };
}

async function setup() {
  const durable = new InMemoryToolGrantStore();
  const services: SentinelServices = {
    ...defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
    tool_grants: durable,
  };
  // The connector as currently configured; a test changes it between the card and the answer.
  const live = { connector: ORIGINAL };
  const callTool = jest.fn(() => Promise.resolve(toolResultResponse({ text: 'a note' })));
  const create = jest.fn();
  create.mockImplementationOnce(() => readNoteStream());
  create.mockImplementation(() => textStream());
  const base = makeTestResolver({ modelClient: makeMockILLM({ create }) });
  const resolver: ITurnResourceResolver = {
    get logger() {
      return base.logger;
    },
    createTracing: () => base.createTracing(),
    resolveAgentSpec: input => base.resolveAgentSpec(input),
    resolveSandbox: input => base.resolveSandbox(input),
    resolveAgentDefinition: async input => {
      const resolved = await base.resolveAgentDefinition(input);
      const source: ToolSource = {
        name: 'mail',
        id: 'mail',
        connector: live.connector,
        listTools: () =>
          Promise.resolve({
            result: {
              tools: [
                {
                  name: 'read_note',
                  description: 'Read a note',
                  inputSchema: { type: 'object' as const, properties: {} },
                  annotations: { readOnlyHint: true, openWorldHint: false },
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
  const sessions = new Sessions({ sessionStore: store, sentinelServices: services });
  const session = await sessions.create({
    tenant_id: 't',
    session_id: 'chat',
    created_by_subject: OWNER,
    agent: { type: 'inline', spec: makeAgentSpec() },
    external_id: 'chat-1',
  });
  const run = async (input: Parameters<typeof session.createTurn>[0]['input']) => {
    const turn = await session.createTurn({
      turn_id: mintTestTurnId(),
      input,
      signal: new AbortController().signal,
      resolver,
    });
    for await (const event of turn.stream()) {
      void event;
    }
    return turn;
  };
  const ask = () => run([{ type: EventType.USER_MESSAGE, content: 'Read my note' }]);
  const alwaysAllow = () => [
    {
      type: EventType.USER_TOOL_APPROVAL,
      thread_id: 'main',
      tool_call_id: 'call-read',
      approval: { status: 'allow' as const, scope: 'always' as const },
    },
  ];
  return { durable, live, store, callTool, ask, run, alwaysAllow };
}

describe('Always allow on a connector tool', () => {
  it('is saved once the decision has committed, for the connector the card was shown for', async () => {
    const { durable, callTool, ask, run, alwaysAllow } = await setup();
    await ask();
    expect(callTool).not.toHaveBeenCalled();

    await run(alwaysAllow());

    expect(callTool).toHaveBeenCalledTimes(1);
    expect(await durable.hasToolGrant(grantKey(ORIGINAL))).toBe(true);
  });

  it('saves nothing when the decision is refused as stale', async () => {
    const { durable, store, callTool, ask, run, alwaysAllow } = await setup();
    await ask();
    jest.spyOn(store, 'createTurn').mockRejectedValueOnce(new StaleApprovalContinuationError('turn-a', 'turn-b'));

    await expect(run(alwaysAllow())).rejects.toBeInstanceOf(StaleApprovalContinuationError);

    expect(callTool).not.toHaveBeenCalled();
    expect(await durable.hasToolGrant(grantKey(ORIGINAL))).toBe(false);
  });

  it('saves nothing when the connector was repointed or re-credentialed after the card was shown', async () => {
    const { durable, live, callTool, ask, run, alwaysAllow } = await setup();
    await ask();
    live.connector = REPOINTED;

    await run(alwaysAllow());

    expect(callTool).toHaveBeenCalledTimes(1);
    expect(await durable.hasToolGrant(grantKey(ORIGINAL))).toBe(false);
    expect(await durable.hasToolGrant(grantKey(REPOINTED))).toBe(false);
  });
});

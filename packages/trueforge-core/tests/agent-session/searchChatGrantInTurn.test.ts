/**
 * "Allow searches in this chat" given on a held search covers the rest of the same reply.
 * Driven through SessionHandle, so the grant the approval adds is the one the next search reads.
 */
import type { ITurnResourceResolver } from '../../src/agent-session/ITurnResourceResolver';
import { EventType } from '../../src/agent-session/schemas/events';
import { Sessions } from '../../src/agent-session/Sessions';
import { InMemorySessionStore } from '../../src/agent-session/store/InMemorySessionStore';
import type { ExtendedChatCompletionChunk, RawAssistantMessageWithUsage } from '../../src/core/llm/LLMTypes';
import { getEmptyUsage } from '../../src/core/llm/LLMTypes';
import type { ToolSource } from '../../src/core/mcp/IMCPServer';
import { toolResultResponse } from '../../src/core/mcp/IMCPServer';
import { ToolSet } from '../../src/core/mcp/ToolSet';
import { createSentinelHostContext, defaultSentinelServices } from '../../src/core/permissions';
import type { AuditRecordInput } from '../../src/core/permissions/audit';
import { markPrivateDataRead, recordPrivateReadText } from '../../src/core/permissions/webSearch';
import { makeAgentSpec, makeMockILLM, makeTestResolver, mintTestTurnId } from './testHelpers';

const OWNER = { subject_id: 'user-1', subject_type: 'user' as const, subject_display_name: 'user-1' };

// eslint-disable-next-line @typescript-eslint/require-await -- async generator fixture, not awaiting I/O
async function* searchStream(input: {
  id: string;
  query: string;
}): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  const toolCalls = [
    {
      id: input.id,
      type: 'function' as const,
      function: { name: 'lookup', arguments: JSON.stringify({ query: input.query }) },
    },
  ];
  yield {
    id: `chunk-${input.id}`,
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
async function* textStream(
  text: string,
): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  yield {
    id: 'chunk-text',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test-model',
    choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: 'stop' }],
  };
  return { output: { role: 'assistant', content: text }, usage: getEmptyUsage(), finish_reason: 'stop' };
}

async function setup() {
  const audit: AuditRecordInput[] = [];
  const services = {
    ...defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
    audit: {
      record: (input: AuditRecordInput) => {
        audit.push(input);
        return Promise.resolve();
      },
    },
  };
  const callTool = jest.fn(() => Promise.resolve(toolResultResponse({ text: '{"results":[]}' })));
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
  const modelClient = makeMockILLM({ create });
  // Each turn gets its own resolver, and so its own search state, as the server builds them.
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
          selectors: { enableTools: ['@all'], disableTools: [], preloadTools: [], requireApprovalForTools: undefined },
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
  const sessions = new Sessions({ sessionStore: new InMemorySessionStore(), sentinelServices: services });
  const session = await sessions.create({
    tenant_id: 't',
    session_id: 'chat',
    created_by_subject: OWNER,
    agent: { type: 'inline', spec: makeAgentSpec() },
    external_id: null,
    source: null,
  });
  const run = async (input: {
    messages: Parameters<typeof session.createTurn>[0]['input'];
    resolver?: ITurnResourceResolver | undefined;
  }) => {
    const turn = await session.createTurn({
      turn_id: mintTestTurnId(),
      input: input.messages,
      signal: new AbortController().signal,
      resolver: input.resolver ?? resolverForTurn(),
    });
    for await (const event of turn.stream()) {
      void event;
    }
    return turn;
  };
  return { session, run, resolverForTurn, create, callTool, audit };
}

describe('"Allow searches in this chat" given during a reply', () => {
  it('lets the next search of the same reply run without asking', async () => {
    const { session, run, resolverForTurn, create, callTool, audit } = await setup();

    // Turn one reads a mail, so the chat has read private data from then on.
    const reading = resolverForTurn();
    markPrivateDataRead(reading.webSearchTurn);
    recordPrivateReadText({ state: reading.webSearchTurn, text: 'Lunch with Ana on Monday.' });
    create.mockImplementationOnce(() => textStream('Read it.'));
    await run({ messages: [{ type: EventType.USER_MESSAGE, content: 'Read my mail' }], resolver: reading });

    // Turn two's search is held for the private read.
    create.mockImplementationOnce(() => searchStream({ id: 'call-1', query: 'tallest building in Lisbon' }));
    const held = await run({ messages: [{ type: EventType.USER_MESSAGE, content: 'Look something up' }] });
    expect((await session.getTurn(held.id))?.state).toMatchObject({
      status: 'done',
      required_actions: [{ type: EventType.TOOL_APPROVAL_REQUIRED }],
    });
    expect(callTool).not.toHaveBeenCalled();

    // The owner allows searches in this chat; the same reply then searches again.
    create.mockImplementationOnce(() => searchStream({ id: 'call-2', query: 'oldest cafe in Lisbon' }));
    create.mockImplementation(() => textStream('Done.'));
    const approved = await run({
      messages: [
        {
          type: EventType.USER_TOOL_APPROVAL,
          thread_id: 'main',
          tool_call_id: 'call-1',
          approval: { status: 'allow', scope: 'chat' },
        },
      ],
    });

    expect((await session.getTurn(approved.id))?.state).toMatchObject({ status: 'done', required_actions: [] });
    expect(callTool).toHaveBeenCalledTimes(2);
    // This turn holds no mail text to check against, so only the chat grant lets the search run unasked.
    expect(audit).toContainEqual(
      expect.objectContaining({ tier: 1, outcome: 'logged', description: 'Searched: oldest cafe in Lisbon' }),
    );
  });
});

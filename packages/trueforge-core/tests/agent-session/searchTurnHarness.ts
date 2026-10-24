/**
 * A chat driven through SessionHandle and the session store, whose model makes one web search through a designated
 * search connector. Each turn gets its own resolver, and so its own search state, as the server builds them.
 */
import type { ITurnResourceResolver } from '../../src/agent-session/ITurnResourceResolver';
import { Sessions } from '../../src/agent-session/Sessions';
import { InMemorySessionStore } from '../../src/agent-session/store/InMemorySessionStore';
import type { ExtendedChatCompletionChunk, RawAssistantMessageWithUsage } from '../../src/core/llm/LLMTypes';
import { getEmptyUsage } from '../../src/core/llm/LLMTypes';
import type { ToolSource } from '../../src/core/mcp/IMCPServer';
import { toolResultResponse } from '../../src/core/mcp/IMCPServer';
import { ToolSet } from '../../src/core/mcp/ToolSet';
import { createSentinelHostContext, defaultSentinelServices } from '../../src/core/permissions';
import type { AuditRecordInput } from '../../src/core/permissions/audit';
import type { Sandbox } from '../../src/core/sandbox/Sandbox';
import { makeAgentSpec, makeMockILLM, makeTestResolver, mintTestTurnId } from './testHelpers';

export const OWNER = { subject_id: 'user-1', subject_type: 'user' as const, subject_display_name: 'user-1' };

// eslint-disable-next-line @typescript-eslint/require-await -- async generator fixture, not awaiting I/O
export async function* searchStream(
  input: { id: string; query: string } | { id: string; args: Record<string, unknown> },
): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  const args = 'args' in input ? input.args : { query: input.query };
  const toolCalls = [
    {
      id: input.id,
      type: 'function' as const,
      function: { name: 'lookup', arguments: JSON.stringify(args) },
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
export async function* textStream(
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

export async function drain(turn: { stream(): AsyncIterable<unknown> }): Promise<void> {
  for await (const event of turn.stream()) {
    void event;
  }
}

let chatCount = 0;

export async function setupSearchChat(
  options: {
    /** The owner's "Web searches run without asking" setting. */
    search_without_asking?: boolean;
    /** The model's reasoning effort, sent with every model call. */
    reasoning_effort?: string;
    /** A sandbox for the chat, so files the person attaches are staged and read as they are in the app. */
    sandbox?: Sandbox;
  } = {},
) {
  // Each test is its own chat: the record of unsaved turns lives for the whole process.
  chatCount += 1;
  const session_id = `chat-${String(chatCount)}`;
  const audit: AuditRecordInput[] = [];
  const services = {
    ...defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
    searchWithoutAsking: () => Promise.resolve(options.search_without_asking ?? true),
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
    const base = makeTestResolver(
      options.sandbox === undefined ? { modelClient } : { modelClient, sandbox: options.sandbox },
    );
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
  const store = new InMemorySessionStore();
  const sessions = new Sessions({ sessionStore: store, sentinelServices: services });
  const session = await sessions.create({
    tenant_id: 't',
    session_id,
    created_by_subject: OWNER,
    agent: {
      type: 'inline',
      spec: makeAgentSpec({
        ...(options.reasoning_effort === undefined
          ? {}
          : { model: { name: 'test-provider/test-model', params: { reasoning_effort: options.reasoning_effort } } }),
        ...(options.sandbox === undefined ? {} : { config: { sandbox: { enabled: true } } }),
      }),
    },
    external_id: null,
    source: null,
  });
  // Each request loads the chat afresh, as the server does.
  const loadChat = async () => {
    const loaded = await sessions.get({ tenant_id: 't', session_id });
    if (loaded === undefined) {
      throw new Error('The test chat is missing.');
    }
    return loaded;
  };
  const run = async (input: {
    messages: Parameters<typeof session.createTurn>[0]['input'];
    resolver?: ITurnResourceResolver | undefined;
  }) => {
    const turn = await (
      await loadChat()
    ).createTurn({
      turn_id: mintTestTurnId(),
      input: input.messages,
      signal: new AbortController().signal,
      resolver: input.resolver ?? resolverForTurn(),
    });
    await drain(turn);
    return turn;
  };
  return {
    session,
    session_id,
    store,
    services,
    loadChat,
    run,
    resolverForTurn,
    create,
    callTool,
    audit,
  };
}

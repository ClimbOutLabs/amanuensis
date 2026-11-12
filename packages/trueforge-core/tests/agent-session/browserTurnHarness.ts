/**
 * A chat driven through SessionHandle and the session store, whose model uses Aman's own browser
 * tools against a fake browser source. Each turn gets its own resolver, as the server builds them.
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
import { makeAgentSpec, makeMockILLM, makeTestResolver, mintTestTurnId } from './testHelpers';

export const BROWSER_OWNER = { subject_id: 'user-1', subject_type: 'user' as const, subject_display_name: 'user-1' };

// eslint-disable-next-line @typescript-eslint/require-await -- async generator fixture, not awaiting I/O
export async function* toolStream(input: {
  id: string;
  name: string;
  args: Record<string, unknown>;
}): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  const toolCalls = [
    {
      id: input.id,
      type: 'function' as const,
      function: { name: input.name, arguments: JSON.stringify(input.args) },
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
export async function* browserTextStream(
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

async function drain(turn: { stream(): AsyncIterable<unknown> }): Promise<void> {
  for await (const event of turn.stream()) {
    void event;
  }
}

let chatCount = 0;

/** A new chat; pass an earlier chat's store to open the new chat beside it, for the same person. */
export async function setupBrowserChat(input: { store?: InMemorySessionStore } = {}) {
  chatCount += 1;
  const session_id = `browser-chat-${String(chatCount)}`;
  const services = defaultSentinelServices({ pinned_path: '/usr/bin:/bin' });
  const callTool = jest.fn((params: { name: string; arguments?: Record<string, unknown> }) => {
    if (params.name === 'browser_read') {
      return Promise.resolve(
        toolResultResponse({ text: 'Weekly newsletter. The harbour festival opens on Friday, rain or shine.' }),
      );
    }
    return Promise.resolve(toolResultResponse({ text: 'The page, as text.' }));
  });
  const source: ToolSource = {
    name: 'browser',
    id: 'browser',
    listTools: () =>
      Promise.resolve({
        result: {
          tools: [
            {
              name: 'browser_read',
              description: 'Reads the open page.',
              inputSchema: { type: 'object' as const, properties: {} },
              annotations: { readOnlyHint: true, openWorldHint: true },
              preload: true,
            },
            {
              name: 'browser_open',
              description: 'Opens a page and reads it back.',
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
        type: 'truefoundry-system',
        mcp_server_id: '',
        mcp_server_name: 'browser',
        original_tool_name: params.name,
      }),
  };
  const create = jest.fn();
  const modelClient = makeMockILLM({ create });
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
  const store = input.store ?? new InMemorySessionStore();
  const sessions = new Sessions({ sessionStore: store, sentinelServices: services });
  const session = await sessions.create({
    tenant_id: 't',
    session_id,
    created_by_subject: BROWSER_OWNER,
    agent: { type: 'inline', spec: makeAgentSpec() },
    external_id: null,
    source: null,
  });
  const loadChat = async () => {
    const loaded = await sessions.get({ tenant_id: 't', session_id });
    if (loaded === undefined) {
      throw new Error('The test chat is missing.');
    }
    return loaded;
  };
  const run = async (input: { messages: Parameters<typeof session.createTurn>[0]['input'] }) => {
    const turn = await (
      await loadChat()
    ).createTurn({
      turn_id: mintTestTurnId(),
      input: input.messages,
      signal: new AbortController().signal,
      resolver: resolverForTurn(),
    });
    await drain(turn);
    return turn;
  };
  return { session, session_id, store, loadChat, run, create, callTool };
}

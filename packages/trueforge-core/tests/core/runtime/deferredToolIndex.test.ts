/**
 * call_tool and get_tool_info against the tool index, and names that exist nowhere.
 *
 * Built-in tools are listed by name only. A call_tool call naming one becomes a direct call of
 * that tool before anything judges it, so it is checked, carded and run exactly as a direct call
 * (the thread-level parity test runs every real tool both ways). A name that exists nowhere fails
 * closed with a plain reason and never becomes an approval card for call_tool.
 */
import { createLogger } from 'winston';
import { z } from 'zod';
import { RemoteMCP, ToolSet } from '../../../src/core';
import type { InternalToolCallInfo, RawAssistantMessage } from '../../../src/core/llm/LLMTypes';
import type { ToolSchema } from '../../../src/core/mcp/IMCPServer';
import { isCallToolResponseResult, toolResultResponse } from '../../../src/core/mcp/IMCPServer';
import { defineTool, LocalToolMCP, type ToolDefinition } from '../../../src/core/mcp/LocalToolMCP';
import type { ToolSelectorConfig } from '../../../src/core/mcp/ToolSelectorPolicy';
import { connectRemoteMcp } from '../../../src/core/mcp/remoteMcpClient';
import type { ConnectorBinding } from '../../../src/core/permissions/approvalTokens';
import {
  createSentinelHostContext,
  defaultSentinelServices,
  type SentinelHostContext,
} from '../../../src/core/permissions/context';
import { classifyUnstampedToolCall } from '../../../src/core/runtime/AgentThread';
import { DeferredTool } from '../../../src/core/runtime/DeferredTool';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { builtInToolIndex } from '../fixtures/toolIndex';
import '../harnessMocks';
import { makeMockIMCPServer, makeSilentLogger, OBJECT_INPUT_SCHEMA } from '../harnessMocks';

jest.mock('../../../src/core/mcp/remoteMcpClient', () => {
  const actual = jest.requireActual<typeof import('../../../src/core/mcp/remoteMcpClient')>(
    '../../../src/core/mcp/remoteMcpClient',
  );
  return { __esModule: true as const, ...actual, connectRemoteMcp: jest.fn() };
});

const mockConnect = jest.mocked(connectRemoteMcp);
const silentLogger = makeSilentLogger();
const noopLogger = createLogger({ silent: true });

const MAPS_HOSTS = {
  geocoder: 'https://geocode.example.internal',
  router: 'https://routes.example.internal',
  walking: 'https://foot.example.internal',
  cycling: 'https://bike.example.internal',
  transit: 'https://transit.example.internal',
  tile: 'https://tiles.example.internal',
};
const MAPS_DESTINATION_HOST =
  'geocode.example.internal, routes.example.internal, foot.example.internal, bike.example.internal, transit.example.internal, tiles.example.internal';

/** A maps-like built-in: no MCP annotations, hosts stamped on toolCallInfo, like the production maps tool set. */
class MapLikeTools extends LocalToolMCP {
  readonly name = 'maps';
  readonly displayName = 'Maps';

  readonly routeCalls: Array<{ from_place: string; to_place: string }> = [];
  readonly mapCalls: Array<{ place_name: string }> = [];

  constructor() {
    super({ tracing: NOOP_AGENT_TRACING });
  }

  private readonly tools: ToolDefinition[] = [
    defineTool({
      name: 'render_map',
      description: 'Renders a map for a place.',
      schema: z.object({ place_name: z.string() }).strict(),
      handler: (input: { place_name: string }) => {
        this.mapCalls.push(input);
        return Promise.resolve(textResult('map ok'));
      },
    }),
    defineTool({
      name: 'render_route',
      description: 'Renders a route between two places.',
      schema: z.object({ from_place: z.string(), to_place: z.string() }).strict(),
      handler: (input: { from_place: string; to_place: string }) => {
        this.routeCalls.push(input);
        return Promise.resolve(textResult('route ok'));
      },
    }),
  ];

  protected getTools(): ToolDefinition[] {
    return this.tools;
  }

  override async toolCallInfo(
    params: Parameters<LocalToolMCP['toolCallInfo']>[0],
    resolveUnderlyingTool?: boolean,
  ): Promise<Awaited<ReturnType<LocalToolMCP['toolCallInfo']>>> {
    const info = await super.toolCallInfo(params, resolveUnderlyingTool);
    return { ...info, maps_hosts: MAPS_HOSTS };
  }

  resolveConnector(): ConnectorBinding {
    return { server_id: 'maps', destination_host: MAPS_DESTINATION_HOST };
  }
}

function textResult(text: string) {
  return toolResultResponse({ text });
}

function makeSentinel(): SentinelHostContext {
  return createSentinelHostContext({
    tenant_id: 't1',
    created_by: 'u1',
    conversation_id: 'c1',
    services: defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
  });
}

async function makeDeferred(builtIns: LocalToolMCP[]): Promise<DeferredTool> {
  const server = makeMockIMCPServer({
    name: 'notes',
    preload: false,
    tools: [{ name: 'search', description: 'search', inputSchema: OBJECT_INPUT_SCHEMA, preload: false }],
  });
  return new DeferredTool([server], {
    tracing: NOOP_AGENT_TRACING,
    logger: silentLogger,
    index: (await builtInToolIndex(builtIns)).index,
  });
}

async function callToolText(
  deferredTool: DeferredTool,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
  const response = await deferredTool.callTool({ name: 'call_tool', arguments: args });
  if (!isCallToolResponseResult(response)) {
    throw new Error('Expected a resolved call_tool response');
  }
  const first = response.result.content[0];
  if (first === undefined || first.type !== 'text') {
    throw new Error('Expected text content');
  }
  return { text: first.text, isError: response.result.isError === true };
}

/** Stamps an unstamped builtin call the way the thread's choke point does. */
async function stamp(input: {
  sentinel: SentinelHostContext;
  info: InternalToolCallInfo;
  canonical_params: Record<string, unknown>;
  connector: ConnectorBinding | undefined;
}): Promise<InternalToolCallInfo> {
  return classifyUnstampedToolCall({
    sentinel: input.sentinel,
    canonical_params: input.canonical_params,
    info: input.info,
    connector: input.connector,
  });
}

function callToolMessage(wrapper: Record<string, unknown>): RawAssistantMessage {
  return {
    role: 'assistant',
    content: null,
    tool_calls: [
      { id: 'call-1', type: 'function', function: { name: 'call_tool', arguments: JSON.stringify(wrapper) } },
    ],
  };
}

describe('the tool index behind get_tool_info and call_tool', () => {
  const inner = { from_place: 'Chiado, Lisboa', to_place: 'Alfama, Lisboa' };

  it('answers get_tool_info for an indexed tool with its full arguments and how to call it', async () => {
    const deferred = await makeDeferred([new MapLikeTools()]);
    const response = await deferred.callTool({
      name: 'get_tool_info',
      arguments: { mcp_server: 'maps', tool_name: 'render_route' },
    });
    if (!isCallToolResponseResult(response) || response.result.content[0]?.type !== 'text') {
      throw new Error('expected a text result');
    }
    const info: unknown = JSON.parse(response.result.content[0].text);
    expect(info).toMatchObject({
      inputSchema: { properties: { from_place: { type: 'string' }, to_place: { type: 'string' } } },
      next_step: 'Call render_route directly by name. It stays loaded for the rest of this chat.',
    });
  });

  it('finds an indexed tool by its name even when the server is misnamed', async () => {
    const deferred = await makeDeferred([new MapLikeTools()]);
    expect(await deferred.resolveIndexedTool({ server: 'map', name: 'render_route' })).toMatchObject({
      name: 'render_route',
      server: 'maps',
    });
  });

  it('turns call_tool naming an indexed tool into a direct call with the inner arguments', async () => {
    const deferred = await makeDeferred([new MapLikeTools()]);
    const { message, rewritten } = await deferred.toDirectCalls(
      callToolMessage({ mcp_server: 'maps', tool_name: 'render_route', input: inner }),
    );
    expect(message.tool_calls).toEqual([
      { id: 'call-1', type: 'function', function: { name: 'render_route', arguments: JSON.stringify(inner) } },
    ]);
    expect(rewritten.get('call-1')?.name).toBe('render_route');
  });

  it('leaves a call to a tool the not-listed connector really has with call_tool', async () => {
    const deferred = await makeDeferred([new MapLikeTools()]);
    const original = callToolMessage({ mcp_server: 'notes', tool_name: 'search', input: { q: 'x' } });
    const { message, rewritten } = await deferred.toDirectCalls(original);
    expect(message).toEqual(original);
    expect(rewritten.size).toBe(0);
  });

  it('runs an indexed tool directly when the model names a connector that does not have it', async () => {
    const deferred = await makeDeferred([new MapLikeTools()]);
    const { message } = await deferred.toDirectCalls(
      callToolMessage({ mcp_server: 'notes', tool_name: 'render_route', input: inner }),
    );
    expect(message.tool_calls?.[0]?.function.name).toBe('render_route');
  });

  it('leaves a call naming nothing indexed with call_tool, which fails it closed', async () => {
    const deferred = await makeDeferred([new MapLikeTools()]);
    const original = callToolMessage({ mcp_server: 'maps', tool_name: 'dance', input: {} });
    expect((await deferred.toDirectCalls(original)).message).toEqual(original);
  });
});

describe('call_tool naming something that does not exist', () => {
  it('fails closed without a card on a tool the named built-in does not have, naming its tools', async () => {
    const maps = new MapLikeTools();
    const deferred = await makeDeferred([maps]);
    const wrapper = { mcp_server: 'maps', tool_name: 'dance', input: {} };

    const { text, isError } = await callToolText(deferred, wrapper);
    expect(isError).toBe(true);
    expect(text).toContain("'maps' has no tool named 'dance'. Its tools: render_map, render_route.");
    expect(maps.routeCalls).toEqual([]);
    expect(maps.mapCalls).toEqual([]);

    const info = await deferred.toolCallInfo({ name: 'call_tool', arguments: wrapper });
    expect(info.tier).toBeUndefined();
    expect(info.pre_dispatch_failure?.message).toContain("'maps' has no tool named 'dance'");
    const stamped = await stamp({ sentinel: makeSentinel(), info, canonical_params: wrapper, connector: undefined });
    expect(stamped).toBe(info);
  });

  it('keeps list_tools for an unknown server at Tier 1 and runs nothing', async () => {
    const maps = new MapLikeTools();
    const deferred = await makeDeferred([maps]);
    const params = { name: 'list_tools', arguments: { mcp_server: 'gmail' } };

    const info = await deferred.toolCallInfo(params);
    const stamped = await stamp({
      sentinel: makeSentinel(),
      info,
      canonical_params: params.arguments,
      connector: undefined,
    });

    expect(stamped.tier).toBe(1);
    expect(stamped.tier3_card).toBeNull();
    const response = await deferred.callTool(params);
    expect(isCallToolResponseResult(response) && response.result.isError).toBe(true);
    expect(JSON.stringify(response)).toContain("No server named 'gmail'.");
  });

  it('fails closed without a card when the named server exists nowhere', async () => {
    const maps = new MapLikeTools();
    const deferred = await makeDeferred([maps]);
    const wrapper = { mcp_server: 'nope', tool_name: 'search', input: {} };

    const info = await deferred.toolCallInfo({ name: 'call_tool', arguments: wrapper });
    expect(info.tier).toBeUndefined();
    expect(info.pre_dispatch_failure?.kind).toBe('pre_dispatch_failed');
    expect(info.pre_dispatch_failure?.message).toContain('nope');

    const sentinel = makeSentinel();
    const stamped = await stamp({ sentinel, info, canonical_params: wrapper, connector: undefined });
    expect(stamped).toBe(info);

    const { text, isError } = await callToolText(deferred, wrapper);
    expect(isError).toBe(true);
    expect(text).toContain("No server named 'nope'.");
  });

  it('fails closed without a card when the wrapper itself does not parse', async () => {
    const deferred = await makeDeferred([new MapLikeTools()]);
    const info = await deferred.toolCallInfo({ name: 'call_tool', arguments: { tool_name: 'search' } });
    expect(info.tier).toBeUndefined();
    expect(info.pre_dispatch_failure?.kind).toBe('pre_dispatch_failed');
    const stamped = await stamp({
      sentinel: makeSentinel(),
      info,
      canonical_params: { tool_name: 'search' },
      connector: undefined,
    });
    expect(stamped).toBe(info);
  });
});

describe('call_tool naming a configured connector still matches the direct call', () => {
  const schema = { type: 'object' as const, properties: {} };
  const webSearch: ToolSchema = {
    name: 'web_search',
    description: 'Search the web.',
    inputSchema: schema,
    annotations: { readOnlyHint: true },
  };
  const sendEmail: ToolSchema = { name: 'send_email', description: 'Send an email.', inputSchema: schema };

  function makeToolSet(input: { name: string; url: string; tools: ToolSchema[] }): ToolSet {
    mockConnect.mockImplementation(() =>
      Promise.resolve({
        transportType: 'streamable-http' as const,
        sessionId: null,
        listTools: () => Promise.resolve({ tools: input.tools }),
        callTool: () => Promise.resolve({ content: [{ type: 'text', text: 'ok' }] }),
        close: () => Promise.resolve(),
      }),
    );
    const remote = new RemoteMCP({
      name: input.name,
      id: input.name,
      url: input.url,
      headers: {},
      logger: noopLogger,
      tracing: NOOP_AGENT_TRACING,
      requestTimeoutMs: 60_000,
      connectTimeoutMs: 5_000,
      signal: new AbortController().signal,
    });
    const selectors: ToolSelectorConfig = { enableTools: ['@all'], disableTools: [], preloadTools: [] };
    return new ToolSet({
      source: remote,
      selectors,
      preload: false,
      sentinel: createSentinelHostContext({
        tenant_id: 't1',
        created_by: 'u1',
        conversation_id: 'c1',
        services: defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
      }),
    });
  }

  it('wrapped connector read matches the direct call', async () => {
    const toolSet = makeToolSet({ name: 'exa', url: 'https://mcp.exa.ai/mcp', tools: [webSearch] });
    const deferred = new DeferredTool([toolSet], { tracing: NOOP_AGENT_TRACING, logger: noopLogger });
    const input = { query: 'my salary history' };
    const direct = await toolSet.toolCallInfo({ name: 'web_search', arguments: input });
    const wrapped = await deferred.toolCallInfo({
      name: 'call_tool',
      arguments: { mcp_server: 'exa', tool_name: 'web_search', input },
    });
    expect(wrapped.tier).toBe(direct.tier);
    expect(wrapped.tier_reason).toBe(direct.tier_reason);
    expect(wrapped.tier3_card).toEqual(direct.tier3_card);
    expect(wrapped.is_approval_required).toBe(direct.is_approval_required);
  });

  it('wrapped connector send matches the direct call', async () => {
    const toolSet = makeToolSet({ name: 'gmail', url: 'https://gmail.example.com/mcp', tools: [sendEmail] });
    const deferred = new DeferredTool([toolSet], { tracing: NOOP_AGENT_TRACING, logger: noopLogger });
    const input = { to: ['alice@example.com'], subject: 'Plan', body: 'See attached.' };
    const direct = await toolSet.toolCallInfo({ name: 'send_email', arguments: input });
    const wrapped = await deferred.toolCallInfo({
      name: 'call_tool',
      arguments: { mcp_server: 'gmail', tool_name: 'send_email', input },
    });
    expect(wrapped.tier).toBe(direct.tier);
    expect(wrapped.tier_reason).toBe(direct.tier_reason);
    expect(wrapped.tier3_card).toEqual(direct.tier3_card);
    expect(wrapped.tier3_card?.plain_what).toBe('Send an email to alice@example.com.');
  });
});

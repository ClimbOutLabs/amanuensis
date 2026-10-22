/**
 * call_tool is for connector tools only. A built-in tool keeps its own name and is always called
 * directly, so a wrapper naming one, or naming anything that exists nowhere, fails closed with a
 * plain reason, runs nothing, and never becomes an approval card for call_tool.
 */
import { createLogger } from 'winston';
import { z } from 'zod';
import { RemoteMCP, ToolSet } from '../../../src/core';
import type { InternalToolCallInfo } from '../../../src/core/llm/LLMTypes';
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

function makeDeferred(): DeferredTool {
  const server = makeMockIMCPServer({
    name: 'notes',
    preload: false,
    tools: [{ name: 'search', description: 'search', inputSchema: OBJECT_INPUT_SCHEMA, preload: false }],
  });
  return new DeferredTool([server], {
    tracing: NOOP_AGENT_TRACING,
    logger: silentLogger,
    bundled: true,
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

describe('call_tool naming a built-in tool', () => {
  const inner = { from_place: 'Chiado, Lisboa', to_place: 'Alfama, Lisboa' };

  it('fails closed without a card when the built-in server is named, and says to call the tool directly', async () => {
    const maps = new MapLikeTools();
    const deferred = makeDeferred();
    const wrapper = { mcp_server: 'maps', tool_name: 'render_route', input: inner };

    const info = await deferred.toolCallInfo({ name: 'call_tool', arguments: wrapper });
    expect(info.tier).toBeUndefined();
    expect(info.pre_dispatch_failure?.message).toContain(
      'Built-in tools are called directly by name, never through call_tool',
    );
    expect(info.pre_dispatch_failure?.message).toContain('load_bundle');
    const stamped = await stamp({ sentinel: makeSentinel(), info, canonical_params: wrapper, connector: undefined });
    expect(stamped).toBe(info);

    const { isError } = await callToolText(deferred, wrapper);
    expect(isError).toBe(true);
    expect(maps.routeCalls).toEqual([]);
  });

  it('runs nothing when a connector is named for a built-in tool it does not have', async () => {
    const maps = new MapLikeTools();
    const deferred = makeDeferred();
    const { text, isError } = await callToolText(deferred, {
      mcp_server: 'notes',
      tool_name: 'render_route',
      input: inner,
    });
    expect(isError).toBe(true);
    expect(text).toContain('A built-in tool is called directly by its name');
    expect(maps.routeCalls).toEqual([]);
  });
});

describe('call_tool naming something that does not exist', () => {
  it('keeps list_tools for an unknown server at Tier 1 and runs nothing', async () => {
    const deferred = makeDeferred();
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
    const deferred = makeDeferred();
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
    const deferred = makeDeferred();
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
    const deferred = new DeferredTool([toolSet], { tracing: NOOP_AGENT_TRACING, logger: noopLogger, bundled: true });
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
    const deferred = new DeferredTool([toolSet], { tracing: NOOP_AGENT_TRACING, logger: noopLogger, bundled: true });
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

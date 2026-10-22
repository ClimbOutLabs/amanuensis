/**
 * call_tool naming a built-in tool set (maps, spaces and the like) or a name
 * that does not exist at all.
 *
 * Built-ins live in the thread's host tool sets, not in the deferred server
 * map, so a wrapper naming one used to fall back to classifying call_tool
 * itself (its card read "This is a new tool from ..." instead of the real tool) and then fail at
 * dispatch with "expected the name of a configured MCP server". These tests
 * pin the fixed behavior: the real tool is judged with its real name and
 * arguments, its decision matches the direct call exactly, and the call
 * runs. A name that exists nowhere fails closed with a plain reason and
 * never becomes an approval card for call_tool.
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

/** A spaces-like built-in: writes declare themselves through hints on toolCallInfo, like the production space tool set. */
class SpaceLikeTools extends LocalToolMCP {
  readonly name = 'space';
  readonly displayName = 'Spaces';

  readonly updateCalls: Array<{ space_id: string; name?: string | undefined }> = [];

  constructor() {
    super({ tracing: NOOP_AGENT_TRACING });
  }

  private readonly tools: ToolDefinition[] = [
    defineTool({
      name: 'create_space',
      description: 'Creates a space.',
      schema: z.object({ name: z.string() }).strict(),
      handler: () => Promise.resolve(textResult('created')),
    }),
    defineTool({
      name: 'update_space',
      description: 'Updates a space.',
      schema: z.object({ space_id: z.string(), name: z.string().optional() }).strict(),
      handler: (input: { space_id: string; name?: string | undefined }) => {
        this.updateCalls.push(input);
        return Promise.resolve(textResult('updated'));
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
    const isRead = params.name === 'list_spaces' || params.name === 'get_space';
    return {
      ...info,
      effect: isRead ? 'inspect' : 'edit',
      read_only_hint: isRead,
      destructive_hint: false,
      open_world_hint: false,
    };
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

function makeDeferred(hostToolSets: LocalToolMCP[]): DeferredTool {
  const server = makeMockIMCPServer({
    name: 'notes',
    preload: false,
    tools: [{ name: 'search', description: 'search', inputSchema: OBJECT_INPUT_SCHEMA, preload: false }],
  });
  return new DeferredTool([server], {
    tracing: NOOP_AGENT_TRACING,
    logger: silentLogger,
    hostToolSets,
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

describe('call_tool naming the built-in maps server', () => {
  const inner = { from_place: 'Chiado, Lisboa', to_place: 'Alfama, Lisboa' };
  const wrapper = { mcp_server: 'maps', tool_name: 'render_route', input: inner };

  it('judges the wrapped route by the real tool and arguments, matching the direct call', async () => {
    const maps = new MapLikeTools();
    const deferred = makeDeferred([maps]);
    const sentinel = makeSentinel();

    const directInfo = await maps.toolCallInfo({ name: 'render_route', arguments: inner });
    const direct = await stamp({
      sentinel,
      info: directInfo,
      canonical_params: inner,
      connector: maps.resolveConnector(),
    });

    const wrappedInfo = await deferred.toolCallInfo({ name: 'call_tool', arguments: wrapper });
    expect(wrappedInfo.original_tool_name).toBe('render_route');
    expect(wrappedInfo.is_deferred).toBe(true);
    const wrapped = await stamp({
      sentinel,
      info: wrappedInfo,
      canonical_params: wrapper,
      connector: deferred.resolveConnector({ name: 'call_tool', arguments: wrapper }),
    });

    expect(wrapped.tier).toBe(3);
    expect(wrapped.tier).toBe(direct.tier);
    expect(wrapped.tier_reason).toBe(direct.tier_reason);
    expect(wrapped.tier3_card).toEqual(direct.tier3_card);
    expect(wrapped.tier3_card?.plain_what).toContain('Chiado, Lisboa');
    expect(wrapped.tier3_card?.plain_what).not.toContain('call_tool');
    expect(wrapped.is_approval_required).toBe(true);
    expect(wrapped.approval_token_id).not.toBeNull();
  });

  it('runs the route on the maps tool set instead of rejecting the server name', async () => {
    const maps = new MapLikeTools();
    const deferred = makeDeferred([maps]);

    const { text, isError } = await callToolText(deferred, wrapper);

    expect(isError).toBe(false);
    expect(text).toBe('route ok');
    expect(text).not.toContain('configured MCP server');
    expect(maps.routeCalls).toEqual([inner]);
  });

  it('names the maps connector for the approval binding', () => {
    const maps = new MapLikeTools();
    const deferred = makeDeferred([maps]);
    expect(deferred.resolveConnector({ name: 'call_tool', arguments: wrapper })).toEqual({
      server_id: 'maps',
      destination_host: MAPS_DESTINATION_HOST,
    });
  });
});

describe('call_tool naming the built-in spaces server', () => {
  const inner = { space_id: 'sp1', name: 'Home renovation' };
  const wrapper = { mcp_server: 'space', tool_name: 'update_space', input: inner };

  it('judges the wrapped space write by the real tool, matching the direct call', async () => {
    const spaces = new SpaceLikeTools();
    const deferred = makeDeferred([spaces]);
    const sentinel = makeSentinel();

    const directInfo = await spaces.toolCallInfo({ name: 'update_space', arguments: inner });
    const direct = await stamp({
      sentinel,
      info: directInfo,
      canonical_params: inner,
      connector: undefined,
    });

    const wrappedInfo = await deferred.toolCallInfo({ name: 'call_tool', arguments: wrapper });
    expect(wrappedInfo.original_tool_name).toBe('update_space');
    const wrapped = await stamp({
      sentinel,
      info: wrappedInfo,
      canonical_params: wrapper,
      connector: deferred.resolveConnector({ name: 'call_tool', arguments: wrapper }),
    });

    expect(wrapped.tier).toBe(direct.tier);
    expect(wrapped.tier_reason).toBe(direct.tier_reason);
    expect(wrapped.tier3_card).toEqual(direct.tier3_card);
    expect(wrapped.tier3_card?.plain_what ?? '').not.toContain('call_tool');
  });

  it('runs the write on the space tool set', async () => {
    const spaces = new SpaceLikeTools();
    const deferred = makeDeferred([spaces]);

    const { text, isError } = await callToolText(deferred, wrapper);

    expect(isError).toBe(false);
    expect(text).toBe('updated');
    expect(spaces.updateCalls).toEqual([inner]);
  });
});

describe('call_tool naming something that does not exist', () => {
  it('fails closed on a tool the named built-in does not have, naming the real tool', async () => {
    const maps = new MapLikeTools();
    const deferred = makeDeferred([maps]);
    const wrapper = { mcp_server: 'maps', tool_name: 'dance', input: {} };

    const { text, isError } = await callToolText(deferred, wrapper);
    expect(isError).toBe(true);
    expect(text).toContain("expected the name of a tool on 'maps'");
    expect(text).toContain('render_route');
    expect(maps.routeCalls).toEqual([]);
    expect(maps.mapCalls).toEqual([]);

    const info = await deferred.toolCallInfo({ name: 'call_tool', arguments: wrapper });
    expect(info.original_tool_name).toBe('dance');
    const stamped = await stamp({
      sentinel: makeSentinel(),
      info,
      canonical_params: wrapper,
      connector: deferred.resolveConnector({ name: 'call_tool', arguments: wrapper }),
    });
    expect(stamped.tier).toBe(3);
    expect(stamped.is_approval_required).toBe(true);
    expect(stamped.tier3_card?.plain_what).toContain('This is a new tool from');
    expect(stamped.tier3_card?.plain_what).not.toContain('call_tool');
    expect(stamped.tier3_card?.plain_what).not.toContain('dance');
  });

  it('keeps list_tools for an unknown server at Tier 1 and runs nothing', async () => {
    const maps = new MapLikeTools();
    const deferred = makeDeferred([maps]);
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
    const deferred = makeDeferred([maps]);
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
    const deferred = makeDeferred([new MapLikeTools()]);
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

import type { Logger } from 'winston';
import {
  McpConnectionError,
  RemoteMCP,
  ToolPolicyBlockedError,
  ToolPreDispatchError,
  ToolSet,
} from '../../../src/core';
import {
  isApprovalRequiredResponse,
  isCallToolResponseResult,
  toolResultResponse,
  type MCPAuthRequired,
  type ToolInvocationContext,
  type ToolSchema,
  type ToolSource,
} from '../../../src/core/mcp/IMCPServer';
import type { RemoteMcpHeaders } from '../../../src/core/mcp/RemoteMCP';
import { connectRemoteMcp } from '../../../src/core/mcp/remoteMcpClient';
import type { ToolSelectorConfig } from '../../../src/core/mcp/ToolSelectorPolicy';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';

// RemoteMCP connects itself via connectRemoteMcp; mock it so the split RemoteMCP (connection) +
// ToolSet (policy) can be exercised without real networking. isSessionExpiredError stays real.
jest.mock('../../../src/core/mcp/remoteMcpClient', () => {
  const actualUnknown: unknown = jest.requireActual('../../../src/core/mcp/remoteMcpClient');
  const actual = actualUnknown as typeof import('../../../src/core/mcp/remoteMcpClient');
  return { __esModule: true as const, ...actual, connectRemoteMcp: jest.fn() };
});

const mockConnect = connectRemoteMcp as jest.MockedFunction<typeof connectRemoteMcp>;

const noopLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as unknown as Logger;

const READ_TOOL: ToolSchema = {
  name: 'read_thing',
  inputSchema: { type: 'object' },
  annotations: { readOnlyHint: true },
};
const WRITE_TOOL: ToolSchema = {
  name: 'write_thing',
  inputSchema: { type: 'object' },
  annotations: { readOnlyHint: false },
};
const OPEN_WORLD_READ_TOOL: ToolSchema = {
  name: 'open_world_read_thing',
  inputSchema: { type: 'object' },
  annotations: { readOnlyHint: true, openWorldHint: true },
};
const UNANNOTATED_TOOL: ToolSchema = {
  name: 'unannotated_thing',
  inputSchema: { type: 'object' },
};
// Partially annotated: sets openWorldHint but never asserts readOnlyHint === true, so it still
// matches @unclassified (isReadOnly stays false).
const PARTIALLY_ANNOTATED_TOOL: ToolSchema = {
  name: 'partially_annotated_thing',
  inputSchema: { type: 'object' },
  annotations: { openWorldHint: true },
};

const DEFAULT_SELECTORS: ToolSelectorConfig = {
  enableTools: ['@all'],
  disableTools: [],
  preloadTools: [],
  requireApprovalForTools: [],
};

// Shared, mutable state backing the mocked connection so tests can assert connect/callTool/close
// counts and queue errors, mirroring the previous FakeTransport.
interface FakeConnectionState {
  connectCalls: number;
  callToolCalls: number;
  closes: number;
  queueCallToolError(error: unknown): void;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error('unknown error');
}

function installFakeConnection(
  opts: { tools?: ToolSchema[]; sessionId?: string | null; connectError?: unknown; listToolsError?: unknown } = {},
): FakeConnectionState {
  const callToolErrors: unknown[] = [];
  const state: FakeConnectionState = {
    connectCalls: 0,
    callToolCalls: 0,
    closes: 0,
    queueCallToolError: (error: unknown) => callToolErrors.push(error),
  };

  mockConnect.mockImplementation(() => {
    state.connectCalls += 1;
    if (opts.connectError) {
      return Promise.reject(toError(opts.connectError));
    }
    return Promise.resolve({
      transportType: 'streamable-http' as const,
      sessionId: opts.sessionId ?? null,
      listTools: () =>
        opts.listToolsError
          ? Promise.reject(toError(opts.listToolsError))
          : Promise.resolve({ tools: opts.tools ?? [READ_TOOL, WRITE_TOOL] }),
      callTool: callParams => {
        state.callToolCalls += 1;
        const queued = callToolErrors.shift();
        if (queued) {
          return Promise.reject(toError(queued));
        }
        return Promise.resolve({ content: [{ type: 'text', text: `called ${callParams.name}` }] });
      },
      close: () => {
        state.closes += 1;
        return Promise.resolve();
      },
    });
  });

  return state;
}

function makeServer(params: {
  selectors?: ToolSelectorConfig | undefined;
  preload?: boolean | undefined;
  sessionId?: string | undefined;
  transportType?: 'streamable-http' | 'sse' | undefined;
  headers?: RemoteMcpHeaders | undefined;
}): ToolSet {
  const remote = new RemoteMCP({
    name: 'my-inline',
    id: 'inline-id-123',
    url: 'https://mcp.example.com/mcp',
    headers: params.headers ?? {},
    logger: noopLogger,
    tracing: NOOP_AGENT_TRACING,
    sessionId: params.sessionId,
    transportType: params.transportType,
    requestTimeoutMs: 60_000,
    connectTimeoutMs: 5_000,
    signal: new AbortController().signal,
  });
  return new ToolSet({
    source: remote,
    selectors: params.selectors ?? DEFAULT_SELECTORS,
    preload: params.preload ?? false,
  });
}

describe('RemoteMCP + ToolSet', () => {
  it('forwards the exact invocation context object to the wrapped source', async () => {
    const context: ToolInvocationContext = {
      admission_provenance: { source: 'automatic' },
      dispatch_id: 'request-123',
    };
    let receivedContext: ToolInvocationContext | undefined;
    const source: ToolSource = {
      name: 'context-source',
      id: 'context-source-id',
      listTools: () =>
        Promise.resolve({
          result: { tools: [{ ...READ_TOOL, preload: true }] },
          wasInitialized: undefined,
        }),
      callTool: (_params, _approvalDecision, invocationContext) => {
        receivedContext = invocationContext;
        return Promise.resolve(toolResultResponse({ text: 'ok' }));
      },
      toolCallInfo: params =>
        Promise.resolve({
          type: 'truefoundry-system',
          mcp_server_id: 'context-source-id',
          mcp_server_name: 'context-source',
          original_tool_name: params.name,
          is_approval_required: false,
        }),
    };
    const server = new ToolSet({ source, selectors: DEFAULT_SELECTORS, preload: false });

    await server.callTool({ name: 'read_thing', arguments: {} }, undefined, context);

    expect(receivedContext).toBe(context);
  });

  it('connects once, emits init info with session id, and caches across listTools calls', async () => {
    const state = installFakeConnection({ sessionId: 'sess-1' });
    const server = makeServer({});

    const first = await server.listTools();
    if ('authRequired' in first) throw new Error('unexpected oauth');
    expect(first.wasInitialized).toEqual({
      id: 'inline-id-123',
      name: 'my-inline',
      session_id: 'sess-1',
      transport_type: 'streamable-http',
    });
    expect(first.result.tools.map(t => t.name).sort()).toEqual(['read_thing', 'write_thing']);

    const second = await server.listTools();
    if ('authRequired' in second) throw new Error('unexpected oauth');
    // Cached: no re-connect and no duplicate init emission.
    expect(second.wasInitialized).toBeUndefined();
    expect(state.connectCalls).toBe(1);
  });

  it('seeds a persisted transport type as knownTransportType so the connect skips the probe', async () => {
    installFakeConnection({ sessionId: 'sess-1' });
    const server = makeServer({ sessionId: 'sess-1', transportType: 'sse' });

    await server.listTools();
    expect(mockConnect).toHaveBeenCalledWith(expect.objectContaining({ knownTransportType: 'sse' }));
  });

  it('probes (no knownTransportType) when there is no persisted transport type', async () => {
    installFakeConnection({ sessionId: 'sess-1' });
    const server = makeServer({ sessionId: 'sess-1' });

    await server.listTools();
    const firstCall = mockConnect.mock.calls[0];
    expect(firstCall).toBeDefined();
    expect(firstCall?.[0]?.knownTransportType).toBeUndefined();
  });

  it('applies enable/disable selectors and preload annotation', async () => {
    installFakeConnection();
    const server = makeServer({
      selectors: { enableTools: ['@read-only'], disableTools: [], preloadTools: ['read_thing'] },
    });

    const res = await server.listTools();
    if ('authRequired' in res) throw new Error('unexpected oauth');
    expect(res.result.tools.map(t => t.name)).toEqual(['read_thing']);
    expect(res.result.tools[0]?.preload).toBe(true);
    expect(server.getAllowedToolNamesForSandbox()).toEqual(['read_thing']);
  });

  it('throws a 422 McpConnectionError when a literal enable tool is missing', async () => {
    installFakeConnection();
    const server = makeServer({
      selectors: { enableTools: ['does_not_exist'], disableTools: [], preloadTools: [] },
    });
    await expect(server.listTools()).rejects.toMatchObject({
      constructor: McpConnectionError,
      statusCode: 422,
    });
  });

  it('does not throw the missing-enable-literal 422 during annotation lookups (only explicit listTools)', async () => {
    const state = installFakeConnection();
    const server = makeServer({
      selectors: { enableTools: ['does_not_exist'], disableTools: [], preloadTools: [] },
    });
    // Annotation lookups (toolCallInfo / callTool preflight) fetch the raw tool list and
    // must not run the missing-literal guard, so deferred paths behave like the pre-refactor inner cache.
    await expect(server.toolCallInfo({ name: 'read_thing', arguments: {} })).resolves.toMatchObject({
      original_tool_name: 'read_thing',
    });
    expect(state.connectCalls).toBe(1);
    // The guard still fires on an explicit listTools().
    await expect(server.listTools()).rejects.toMatchObject({ statusCode: 422 });
  });

  it('rejects a disallowed tool call with a 403 McpConnectionError', async () => {
    const state = installFakeConnection();
    const server = makeServer({
      selectors: { enableTools: ['@read-only'], disableTools: [], preloadTools: [] },
    });
    await server.listTools();
    await expect(server.callTool({ name: 'write_thing', arguments: {} })).rejects.toMatchObject({
      constructor: ToolPolicyBlockedError,
      statusCode: 403,
    });
    expect(state.callToolCalls).toBe(0);
  });

  it('identifies tool-list failure as pre-dispatch and never calls the provider tool', async () => {
    const state = installFakeConnection({ listToolsError: new Error('catalog unavailable') });
    const server = makeServer({});

    await expect(server.callTool({ name: 'read_thing', arguments: {} })).rejects.toBeInstanceOf(ToolPreDispatchError);
    await expect(server.toolCallInfo({ name: 'read_thing', arguments: {} })).rejects.toBeInstanceOf(
      ToolPreDispatchError,
    );
    expect(state.callToolCalls).toBe(0);
  });

  it('returns approvalRequired for an approval-gated tool when no decision is supplied', async () => {
    const state = installFakeConnection();
    const server = makeServer({
      selectors: { enableTools: ['@all'], disableTools: [], preloadTools: [], requireApprovalForTools: ['@write'] },
    });
    await server.listTools();

    const res = await server.callTool({ name: 'write_thing', arguments: {} });
    expect(isApprovalRequiredResponse(res)).toBe(true);
    expect(state.callToolCalls).toBe(0);
  });

  it('honors an empty require_approval_for_tools list (no approvals, including unclassified tools)', async () => {
    const state = installFakeConnection({ tools: [READ_TOOL, WRITE_TOOL, UNANNOTATED_TOOL] });
    const server = makeServer({
      selectors: { enableTools: ['@all'], disableTools: [], preloadTools: [], requireApprovalForTools: [] },
    });
    await server.listTools();

    const res = await server.callTool({ name: 'write_thing', arguments: {} });
    if (!isCallToolResponseResult(res)) throw new Error('expected result response');
    expect(res.result.isError).toBeFalsy();

    // The explicit opt-out (`[]`) is honored exactly, even for an unannotated tool that would
    // otherwise match the new @unclassified default.
    const unannotatedRes = await server.callTool({ name: 'unannotated_thing', arguments: {} });
    if (!isCallToolResponseResult(unannotatedRes)) throw new Error('expected result response');
    expect(unannotatedRes.result.isError).toBeFalsy();

    expect(state.callToolCalls).toBe(2);
  });

  it('requires approval by default for a tool with no annotations at all (fail-closed)', async () => {
    const state = installFakeConnection({ tools: [UNANNOTATED_TOOL] });
    // No requireApprovalForTools override: exercises the real DEFAULT_REQUIRE_APPROVAL_FOR_TOOLS.
    const server = makeServer({
      selectors: { enableTools: ['@all'], disableTools: [], preloadTools: [] },
    });
    await server.listTools();

    const res = await server.callTool({ name: 'unannotated_thing', arguments: {} });
    expect(isApprovalRequiredResponse(res)).toBe(true);
    expect(state.callToolCalls).toBe(0);
  });

  it('still requires no approval by default for a tool with readOnlyHint: true', async () => {
    const state = installFakeConnection({ tools: [READ_TOOL] });
    const server = makeServer({
      selectors: { enableTools: ['@all'], disableTools: [], preloadTools: [] },
    });
    await server.listTools();

    const res = await server.callTool({ name: 'read_thing', arguments: {} });
    if (!isCallToolResponseResult(res)) throw new Error('expected result response');
    expect(res.result.isError).toBeFalsy();
    expect(state.callToolCalls).toBe(1);
  });

  it('does not gate an unannotated tool when require_approval_for_tools is explicitly narrowed (operator intent wins)', async () => {
    const state = installFakeConnection({ tools: [UNANNOTATED_TOOL] });
    const server = makeServer({
      selectors: {
        enableTools: ['@all'],
        disableTools: [],
        preloadTools: [],
        requireApprovalForTools: ['@destructive'],
      },
    });
    await server.listTools();

    const res = await server.callTool({ name: 'unannotated_thing', arguments: {} });
    if (!isCallToolResponseResult(res)) throw new Error('expected result response');
    expect(res.result.isError).toBeFalsy();
    expect(state.callToolCalls).toBe(1);
  });

  it('@unclassified matches a partially-annotated tool that only sets openWorldHint', async () => {
    const state = installFakeConnection({ tools: [PARTIALLY_ANNOTATED_TOOL] });
    const server = makeServer({
      selectors: {
        enableTools: ['@all'],
        disableTools: [],
        preloadTools: [],
        requireApprovalForTools: ['@unclassified'],
      },
    });
    await server.listTools();

    const res = await server.callTool({ name: 'partially_annotated_thing', arguments: {} });
    expect(isApprovalRequiredResponse(res)).toBe(true);
    expect(state.callToolCalls).toBe(0);
  });

  it('honors literal require_approval_for_tools without gating other write tools', async () => {
    const state = installFakeConnection();
    const server = makeServer({
      selectors: {
        enableTools: ['@all'],
        disableTools: [],
        preloadTools: [],
        requireApprovalForTools: ['write_thing'],
      },
    });
    await server.listTools();

    const gated = await server.callTool({ name: 'write_thing', arguments: {} });
    expect(isApprovalRequiredResponse(gated)).toBe(true);
    expect(state.callToolCalls).toBe(0);

    const ungated = await server.callTool({ name: 'read_thing', arguments: {} });
    if (!isCallToolResponseResult(ungated)) throw new Error('expected result response');
    expect(ungated.result.isError).toBeFalsy();
    expect(state.callToolCalls).toBe(1);
  });

  it('short-circuits a denied tool call without hitting the transport', async () => {
    const state = installFakeConnection();
    const server = makeServer({});
    await server.listTools();

    const res = await server.callTool({ name: 'write_thing', arguments: {} }, { status: 'deny', reason: 'nope' });
    if (!isCallToolResponseResult(res)) throw new Error('expected result response');
    expect(res.result.isError).toBe(true);
    expect(state.callToolCalls).toBe(0);
  });

  it('retries once on an expired session, reconnecting transparently', async () => {
    const state = installFakeConnection({ sessionId: 'sess-1' });
    const server = makeServer({});
    await server.listTools();
    expect(state.connectCalls).toBe(1);

    state.queueCallToolError(new Error('session-expired'));
    const res = await server.callTool({ name: 'read_thing', arguments: {} });
    if (!isCallToolResponseResult(res)) throw new Error('expected result response');
    // First attempt failed with expiry, reset + reconnect, second attempt succeeded.
    expect(state.connectCalls).toBe(2);
    expect(state.callToolCalls).toBe(2);
  });

  it('wraps a non-auth connect failure in a server-named McpConnectionError preserving the status hint', async () => {
    installFakeConnection({ connectError: new McpConnectionError('upstream down', 502) });
    const server = makeServer({});
    try {
      await server.listTools();
      throw new Error('expected listTools to reject');
    } catch (err) {
      expect(err).toBeInstanceOf(McpConnectionError);
      expect(err).toMatchObject({ statusCode: 502 });
      expect((err as McpConnectionError).message).toContain("remote MCP server 'my-inline'");
    }
  });

  it('wraps a 401 on connect as a server-named McpConnectionError (inline never enters auth-required)', async () => {
    const state = installFakeConnection({ connectError: new McpConnectionError('upstream 401', 401) });
    const server = makeServer({});

    try {
      await server.listTools();
      throw new Error('expected listTools to reject');
    } catch (err) {
      expect(err).toBeInstanceOf(McpConnectionError);
      expect(err).toMatchObject({ statusCode: 401 });
      expect((err as McpConnectionError).message).toContain("remote MCP server 'my-inline'");
    }
    expect(state.connectCalls).toBe(1);
  });

  it('short-circuits with authRequired when the headers resolver signals auth-required', async () => {
    const state = installFakeConnection();
    const authRequired: MCPAuthRequired = {
      servers: [{ id: 'inline-id-123', name: 'my-inline', auth_url: 'https://auth.example' }],
    };
    const headers: RemoteMcpHeaders = () => Promise.resolve({ authRequired });
    const server = makeServer({
      headers,
      selectors: { enableTools: ['@read-only'], disableTools: [], preloadTools: [] },
    });

    const listRes = await server.listTools();
    expect(listRes).toEqual({ authRequired });

    // callTool surfaces auth-required before the annotation-based allow/approval checks.
    const callRes = await server.callTool({ name: 'read_thing', arguments: {} });
    expect(callRes).toEqual({ authRequired });

    // The resolver signalled auth before any network use.
    expect(state.connectCalls).toBe(0);
    expect(state.callToolCalls).toBe(0);
  });

  it('re-checks auth on every op: a mid-session auth revocation surfaces authRequired on the next callTool', async () => {
    const state = installFakeConnection({ sessionId: 'sess-1' });
    const authRequired: MCPAuthRequired = {
      servers: [{ id: 'inline-id-123', name: 'my-inline', auth_url: 'https://auth.example' }],
    };
    // Headers resolve fine at connect time, then flip to auth-required (e.g. token revoked mid-request).
    const headers = jest
      .fn<Promise<{ headers: Record<string, string> } | { authRequired: MCPAuthRequired }>, []>()
      .mockResolvedValueOnce({ headers: {} })
      .mockResolvedValue({ authRequired });
    const server = makeServer({ headers });

    const first = await server.listTools();
    if ('authRequired' in first) throw new Error('expected successful first connect');
    expect(state.connectCalls).toBe(1);

    // Already connected, but auth is re-checked: the revocation must surface instead of a tool result.
    const callRes = await server.callTool({ name: 'read_thing', arguments: {} });
    expect(callRes).toEqual({ authRequired });
    expect(state.callToolCalls).toBe(0);
  });

  it('emits init for a stateless (SSE) server on connect (matches gateway strict-compare behavior)', async () => {
    // Stateless connection reports a null session id.
    installFakeConnection({ sessionId: null });

    // First turn: never-connected (undefined) -> stateless (null) counts as a change, so init is
    // emitted once, carrying transport_type so a later turn can skip the probe. session_id is absent.
    const firstTurn = makeServer({});
    const first = await firstTurn.listTools();
    if ('authRequired' in first) throw new Error('unexpected oauth');
    expect(first.wasInitialized).toEqual({
      id: 'inline-id-123',
      name: 'my-inline',
      session_id: undefined,
      transport_type: 'streamable-http',
    });

    // A resume turn (hydrated with no session id) still emits, mirroring the gateway.
    const secondTurn = makeServer({ sessionId: undefined });
    const second = await secondTurn.listTools();
    if ('authRequired' in second) throw new Error('unexpected oauth');
    expect(second.wasInitialized).toMatchObject({ id: 'inline-id-123', name: 'my-inline' });
  });

  it('resolves dynamic headers from the resolver and connects normally', async () => {
    const state = installFakeConnection({ sessionId: 'sess-1' });
    const headers = jest
      .fn<Promise<{ headers: Record<string, string> }>, []>()
      .mockResolvedValue({ headers: { Authorization: 'Bearer live-token' } });
    const server = makeServer({ headers });

    const res = await server.listTools();
    if ('authRequired' in res) throw new Error('unexpected auth-required');
    expect(res.result.tools.map(t => t.name).sort()).toEqual(['read_thing', 'write_thing']);
    expect(headers).toHaveBeenCalled();

    // Second (cached) listTools does not re-resolve headers — resolution happens only at connect.
    await server.listTools();
    expect(headers).toHaveBeenCalledTimes(1);
    expect(state.connectCalls).toBe(1);
  });

  describe('effect classification', () => {
    it('gives a read-only tool with no openWorldHint effect: inspect', async () => {
      installFakeConnection({ tools: [READ_TOOL] });
      const server = makeServer({});

      await expect(server.toolCallInfo({ name: 'read_thing', arguments: {} })).resolves.toMatchObject({
        effect: 'inspect',
      });
    });

    it('does not classify a read-only tool with openWorldHint: true (security-critical: data can leave the machine via arguments)', async () => {
      installFakeConnection({ tools: [OPEN_WORLD_READ_TOOL] });
      const server = makeServer({});

      const info = await server.toolCallInfo({ name: 'open_world_read_thing', arguments: {} });
      expect(info).not.toHaveProperty('effect');
    });

    it('does not classify a tool with readOnlyHint: false', async () => {
      installFakeConnection({ tools: [WRITE_TOOL] });
      const server = makeServer({});

      const info = await server.toolCallInfo({ name: 'write_thing', arguments: {} });
      expect(info).not.toHaveProperty('effect');
    });

    it('does not classify a tool with no annotations at all (absence is never read as the reassuring answer)', async () => {
      installFakeConnection({ tools: [UNANNOTATED_TOOL] });
      const server = makeServer({});

      const info = await server.toolCallInfo({ name: 'unannotated_thing', arguments: {} });
      expect(info).not.toHaveProperty('effect');
    });
  });
});

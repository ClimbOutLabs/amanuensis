import { createLogger } from 'winston';
import { RemoteMCP, ToolSet, createSentinelHostContext, defaultSentinelServices } from '../../../src/core';
import type { ToolSchema } from '../../../src/core/mcp/IMCPServer';
import { connectRemoteMcp } from '../../../src/core/mcp/remoteMcpClient';
import type { ToolSelectorConfig } from '../../../src/core/mcp/ToolSelectorPolicy';
import type { AuditRecordInput } from '../../../src/core/permissions/audit';
import type { SentinelServices } from '../../../src/core/permissions/context';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';

jest.mock('../../../src/core/mcp/remoteMcpClient', () => {
  const actual = jest.requireActual<typeof import('../../../src/core/mcp/remoteMcpClient')>(
    '../../../src/core/mcp/remoteMcpClient',
  );
  return { __esModule: true as const, ...actual, connectRemoteMcp: jest.fn() };
});

const mockConnect = jest.mocked(connectRemoteMcp);
const noopLogger = createLogger({ silent: true });
const SERVER_NAME = 'notes';

function makeToolSet(params: {
  tools: ToolSchema[];
  services: SentinelServices;
  requireApprovalForTools?: string[];
}): ToolSet {
  mockConnect.mockImplementation(() =>
    Promise.resolve({
      transportType: 'streamable-http' as const,
      sessionId: null,
      listTools: () => Promise.resolve({ tools: params.tools }),
      callTool: callParams => Promise.resolve({ content: [{ type: 'text', text: `called ${callParams.name}` }] }),
      close: () => Promise.resolve(),
    }),
  );
  const remote = new RemoteMCP({
    name: SERVER_NAME,
    id: SERVER_NAME,
    url: 'https://mcp.example.com/mcp',
    headers: {},
    logger: noopLogger,
    tracing: NOOP_AGENT_TRACING,
    requestTimeoutMs: 60_000,
    connectTimeoutMs: 5_000,
    signal: new AbortController().signal,
  });
  const selectors: ToolSelectorConfig = {
    enableTools: ['@all'],
    disableTools: [],
    preloadTools: [],
    requireApprovalForTools: params.requireApprovalForTools,
  };
  return new ToolSet({
    source: remote,
    selectors,
    preload: false,
    sentinel: createSentinelHostContext({
      tenant_id: 't1',
      created_by: 'u1',
      conversation_id: 'c1',
      services: params.services,
    }),
  });
}

const schema = { type: 'object' as const, properties: {} };
const closedWorldRead: ToolSchema = {
  name: 'lookup_note',
  description: 'Reads a note.',
  inputSchema: schema,
  annotations: { readOnlyHint: true, openWorldHint: false },
};
const readWithoutOpenWorld: ToolSchema = {
  name: 'peek_note',
  description: 'Reads a note.',
  inputSchema: schema,
  annotations: { readOnlyHint: true },
};
const destructiveRead: ToolSchema = {
  name: 'archive_note',
  description: 'Archives a note.',
  inputSchema: schema,
  annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: true },
};
const unannotated: ToolSchema = { name: 'poke_note', description: 'Does something.', inputSchema: schema };

function servicesWithGrants(toolNames: string[]): SentinelServices {
  const services = defaultSentinelServices({ pinned_path: '/usr/bin:/bin' });
  for (const tool_name of toolNames) {
    void services.tool_grants.recordToolGrant({
      tenant_id: 't1',
      created_by: 'u1',
      mcp_server_name: SERVER_NAME,
      tool_name,
    });
  }
  return services;
}

describe('ToolSet Sentinel classification of connector tools', () => {
  it('asks on first use for a read-only, explicitly closed-world tool, and marks it eligible for a grant', async () => {
    const info = await makeToolSet({ tools: [closedWorldRead], services: servicesWithGrants([]) }).toolCallInfo({
      name: 'lookup_note',
      arguments: {},
    });
    expect(info.tier).toBe(3);
    expect(info.is_approval_required).toBe(true);
    expect(info.effect).toBe('inspect');
  });

  it('runs a tool the user always allows at Tier 1, without approval, and audits the run exactly once', async () => {
    const services = servicesWithGrants(['lookup_note']);
    const recorded: AuditRecordInput[] = [];
    services.audit = {
      record: input => {
        recorded.push(input);
        return Promise.resolve();
      },
      updateOutcome: () => Promise.resolve(),
    };
    const toolSet = makeToolSet({ tools: [closedWorldRead], services });

    const info = await toolSet.toolCallInfo({ name: 'lookup_note', arguments: {} });
    expect(info.tier).toBe(1);
    expect(info.is_approval_required).toBe(false);
    // Classification runs several times per call; only the dispatch is the run.
    expect(recorded).toEqual([]);

    const response = await toolSet.callTool({ name: 'lookup_note', arguments: {} });
    expect(response).not.toHaveProperty('approvalRequired');
    expect(recorded).toEqual([
      expect.objectContaining({ tier: 1, tool_name: 'lookup_note', outcome: 'logged', conversation_id: 'c1' }),
    ]);
  });

  it('asks instead of running when the grant is missing, and audits nothing', async () => {
    const services = servicesWithGrants([]);
    const recorded: AuditRecordInput[] = [];
    services.audit = {
      record: input => {
        recorded.push(input);
        return Promise.resolve();
      },
      updateOutcome: () => Promise.resolve(),
    };
    const response = await makeToolSet({ tools: [closedWorldRead], services }).callTool({
      name: 'lookup_note',
      arguments: {},
    });
    expect(response).toHaveProperty('approvalRequired');
    expect(recorded).toEqual([]);
  });

  it('keeps asking for a read-only tool that omits openWorldHint, even with a grant, and offers no grant', async () => {
    const info = await makeToolSet({
      tools: [readWithoutOpenWorld],
      services: servicesWithGrants(['peek_note']),
    }).toolCallInfo({ name: 'peek_note', arguments: {} });
    expect(info.tier).toBe(3);
    expect(info.is_approval_required).toBe(true);
    expect(info).not.toHaveProperty('effect');
  });

  it('lets a destructive hint escalate over a grant', async () => {
    const info = await makeToolSet({
      tools: [destructiveRead],
      services: servicesWithGrants(['archive_note']),
    }).toolCallInfo({ name: 'archive_note', arguments: {} });
    expect(info.tier).toBe(3);
    expect(info.is_approval_required).toBe(true);
  });

  it('keeps an unannotated tool at Tier 3 with approval required', async () => {
    const info = await makeToolSet({ tools: [unannotated], services: servicesWithGrants([]) }).toolCallInfo({
      name: 'poke_note',
      arguments: {},
    });
    expect(info.tier).toBe(3);
    expect(info.is_approval_required).toBe(true);
  });

  it('still gates an always-allowed tool that an explicit require-approval selector names', async () => {
    const info = await makeToolSet({
      tools: [closedWorldRead],
      services: servicesWithGrants(['lookup_note']),
      requireApprovalForTools: ['lookup_note'],
    }).toolCallInfo({ name: 'lookup_note', arguments: {} });
    expect(info.tier).toBe(1);
    expect(info.is_approval_required).toBe(true);
  });

  it('does not pause an auto-denied call for approval, even when a selector names it', async () => {
    const services = servicesWithGrants(['lookup_note']);
    services.isOffline = () => Promise.resolve(true);
    const info = await makeToolSet({
      tools: [closedWorldRead],
      services,
      requireApprovalForTools: ['lookup_note'],
    }).toolCallInfo({ name: 'lookup_note', arguments: {} });
    expect(info.tier).toBe(3);
    expect(info.is_approval_required).toBe(false);
    expect(info.pre_dispatch_failure).toEqual({ kind: 'policy_blocked', message: 'Auto-denied: offline mode is on.' });
  });
});

import { createLogger } from 'winston';
import {
  RemoteMCP,
  ToolSet,
  createSentinelHostContext,
  defaultSentinelServices,
  type ToolSource,
} from '../../../src/core';
import { allowsChatApproval, allowsToolGrant } from '../../../src/core/mcp/approvalGrant';
import { toolResultResponse, type ToolSchema } from '../../../src/core/mcp/IMCPServer';
import { createToolCallMemoState, executeToolCalls } from '../../../src/core/mcp/executeToolCalls';
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
  firstParty?: boolean;
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
    firstParty: params.firstParty,
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
      mcp_server_host: 'mcp.example.com',
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

  it('offers chat scope for a plain read-only, closed-world tool', async () => {
    const info = await makeToolSet({ tools: [closedWorldRead], services: servicesWithGrants([]) }).toolCallInfo({
      name: 'lookup_note',
      arguments: {},
    });
    expect(allowsChatApproval(info)).toBe(true);
    expect(allowsToolGrant(info)).toBe(true);
  });

  it.each([
    ['send_message', 'a name the classifier ranks as a send'],
    ['delete_note', 'a name the classifier ranks as destructive'],
    ['install_note_pack', 'a name the classifier ranks as an install'],
  ])('refuses chat scope for %s even though the server declares it read-only and closed-world (%s)', async name => {
    const tool: ToolSchema = {
      name,
      description: 'Claims to only read.',
      inputSchema: schema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    };
    const info = await makeToolSet({ tools: [tool], services: servicesWithGrants([]) }).toolCallInfo({
      name,
      arguments: { to: 'friend@example.com', body: 'hello', package: 'left-pad' },
    });
    expect(info.tier).toBe(3);
    expect(info.is_approval_required).toBe(true);
    expect(info.effect).toBe('inspect');
    expect(allowsChatApproval(info)).toBe(false);
    expect(allowsToolGrant(info)).toBe(false);
  });

  it('tells the owner in plain words, end to end, when a send is refused before it runs', async () => {
    const reply: ToolSchema = { name: 'reply', description: 'Replies.', inputSchema: schema };
    const toolSet = makeToolSet({ tools: [reply], services: servicesWithGrants([]) });
    const info = await toolSet.toolCallInfo({ name: 'reply', arguments: { body: 'ok', cc: ['a@example.com'] } });
    expect(info.pre_dispatch_failure?.kind).toBe('policy_blocked');
    expect(info.pre_dispatch_failure?.owner_message).toMatch(/^Nothing was sent/);

    const result = await executeToolCalls({
      assistantMessage: {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'reply', arguments: '{"body":"ok","cc":["a@example.com"]}' }, tool_info: info },
        ],
      },
      toolMapping: new Map([['reply', { toolSet, originalToolName: 'reply' }]]),
      threadId: 'main',
      approvalDecisions: new Map(),
      memoState: createToolCallMemoState(),
    });

    const remediation = result.toolCallResults[0]?.remediation;
    expect(result.toolCallResults[0]?.disposition).toBe('policy_blocked');
    expect(remediation?.suggested_action).toBe('contact_user');
    expect(remediation?.reason_code).toBe('tool_policy_blocked');
    expect(remediation?.message).toContain('Nothing was sent');
    expect(remediation?.message.length).toBeLessThan(120);
    expect(remediation?.message).not.toMatch(/card/i);
  });

  it('refuses chat scope when the server hints escalate the tier', async () => {
    const info = await makeToolSet({ tools: [destructiveRead], services: servicesWithGrants([]) }).toolCallInfo({
      name: 'archive_note',
      arguments: {},
    });
    expect(info.tier).toBe(3);
    expect(allowsChatApproval(info)).toBe(false);
    expect(allowsToolGrant(info)).toBe(false);
  });

  it('runs a tool the user always allows at Tier 1, without approval, and audits the run exactly once', async () => {
    const services = servicesWithGrants(['lookup_note']);
    const recorded: AuditRecordInput[] = [];
    services.audit = {
      record: input => {
        recorded.push(input);
        return Promise.resolve();
      },
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

describe('ToolSet Sentinel classification of first-party connector tools', () => {
  function auditedServices(): { services: SentinelServices; recorded: AuditRecordInput[] } {
    const services = servicesWithGrants([]);
    const recorded: AuditRecordInput[] = [];
    services.audit = {
      record: input => {
        recorded.push(input);
        return Promise.resolve();
      },
    };
    return { services, recorded };
  }

  it('runs a read-only, explicitly closed-world tool at Tier 1 without approval, and audits the run exactly once', async () => {
    const { services, recorded } = auditedServices();
    const toolSet = makeToolSet({ tools: [closedWorldRead], services, firstParty: true });

    const info = await toolSet.toolCallInfo({ name: 'lookup_note', arguments: {} });
    expect(info.tier).toBe(1);
    expect(info.is_approval_required).toBe(false);
    // Classification runs several times per call; only the dispatch is the run.
    expect(recorded).toEqual([]);

    const response = await toolSet.callTool({ name: 'lookup_note', arguments: {} });
    expect(response).not.toHaveProperty('approvalRequired');
    expect(recorded).toEqual([
      expect.objectContaining({
        tier: 1,
        tool_name: 'lookup_note',
        outcome: 'logged',
        conversation_id: 'c1',
        description: expect.stringContaining('First-party'),
      }),
    ]);
  });

  it('asks for the same tool on a connector that is not first-party, and audits nothing', async () => {
    const { services, recorded } = auditedServices();
    const toolSet = makeToolSet({ tools: [closedWorldRead], services, firstParty: false });

    const response = await toolSet.callTool({ name: 'lookup_note', arguments: {} });
    expect(response).toHaveProperty('approvalRequired');
    expect(recorded).toEqual([]);
  });

  it('keeps asking for a read-only tool that omits openWorldHint', async () => {
    const info = await makeToolSet({
      tools: [readWithoutOpenWorld],
      services: servicesWithGrants([]),
      firstParty: true,
    }).toolCallInfo({ name: 'peek_note', arguments: {} });
    expect(info.tier).toBe(3);
    expect(info.is_approval_required).toBe(true);
  });

  it('lets a destructive hint escalate over first-party trust', async () => {
    const info = await makeToolSet({
      tools: [destructiveRead],
      services: servicesWithGrants([]),
      firstParty: true,
    }).toolCallInfo({ name: 'archive_note', arguments: {} });
    expect(info.tier).toBe(3);
    expect(info.is_approval_required).toBe(true);
  });

  it('keeps an unannotated tool at Tier 3 with approval required', async () => {
    const info = await makeToolSet({
      tools: [unannotated],
      services: servicesWithGrants([]),
      firstParty: true,
    }).toolCallInfo({ name: 'poke_note', arguments: {} });
    expect(info.tier).toBe(3);
    expect(info.is_approval_required).toBe(true);
  });

  it('still gates a first-party tool that an explicit require-approval selector names, and audits nothing', async () => {
    const { services, recorded } = auditedServices();
    const toolSet = makeToolSet({
      tools: [closedWorldRead],
      services,
      requireApprovalForTools: ['lookup_note'],
      firstParty: true,
    });

    const info = await toolSet.toolCallInfo({ name: 'lookup_note', arguments: {} });
    expect(info.tier).toBe(1);
    expect(info.is_approval_required).toBe(true);

    const response = await toolSet.callTool({ name: 'lookup_note', arguments: {} });
    expect(response).toHaveProperty('approvalRequired');
    expect(recorded).toEqual([]);
  });

  it('honors first-party trust for a tool source the host builds itself, with no stored connector behind it', async () => {
    const inProcessSource: ToolSource = {
      name: 'mail',
      id: 'mail',
      listTools: () =>
        Promise.resolve({ result: { tools: [{ ...closedWorldRead, preload: true }] }, wasInitialized: undefined }),
      callTool: params => Promise.resolve(toolResultResponse({ text: `called ${params.name}` })),
      toolCallInfo: params =>
        Promise.resolve({
          type: 'mcp',
          mcp_server_id: 'mail',
          mcp_server_name: 'mail',
          original_tool_name: params.name,
          is_approval_required: false,
        }),
    };
    const sentinel = createSentinelHostContext({
      tenant_id: 't1',
      created_by: 'u1',
      conversation_id: 'c1',
      services: servicesWithGrants([]),
    });
    const selectors: ToolSelectorConfig = {
      enableTools: ['@all'],
      disableTools: [],
      preloadTools: [],
      requireApprovalForTools: [],
    };

    const marked = new ToolSet({ source: inProcessSource, selectors, preload: true, sentinel, firstParty: true });
    const unmarked = new ToolSet({ source: inProcessSource, selectors, preload: true, sentinel });

    expect((await marked.toolCallInfo({ name: 'lookup_note', arguments: {} })).tier).toBe(1);
    expect((await unmarked.toolCallInfo({ name: 'lookup_note', arguments: {} })).tier).toBe(3);
  });

  it('does not run a first-party tool while offline mode auto-denies it', async () => {
    const services = servicesWithGrants([]);
    services.isOffline = () => Promise.resolve(true);
    const info = await makeToolSet({ tools: [closedWorldRead], services, firstParty: true }).toolCallInfo({
      name: 'lookup_note',
      arguments: {},
    });
    expect(info.tier).toBe(3);
    expect(info.pre_dispatch_failure).toEqual({ kind: 'policy_blocked', message: 'Auto-denied: offline mode is on.' });
  });
});

describe('ToolSet Sentinel classification of connector calendar changes', () => {
  // A connector that claims its write is a closed-world read, the way a careless or hostile server can.
  const claimsRead = (name: string): ToolSchema => ({
    name,
    description: 'Adds an event.',
    inputSchema: schema,
    annotations: { readOnlyHint: true, openWorldHint: false },
  });
  const ARGS = { summary: 'Lunch', start: '2026-10-22T12:00' };

  it.each(['create_event', 'update_event', 'add_event', 'insert_event', 'quick_add_event', 'reschedule_meeting'])(
    'asks for %s with its own card and offers neither chat nor always scope',
    async name => {
      const info = await makeToolSet({ tools: [claimsRead(name)], services: servicesWithGrants([]) }).toolCallInfo({
        name,
        arguments: ARGS,
      });
      expect(info).toMatchObject({ tier: 3, tier_reason: 'connector_calendar_write', is_approval_required: true });
      expect(info.approval_token_id).toEqual(expect.any(String));
      expect(allowsChatApproval(info)).toBe(false);
      expect(allowsToolGrant(info)).toBe(false);
    },
  );

  it('keeps asking on a first-party connector, which would otherwise run a closed-world read silently', async () => {
    const info = await makeToolSet({
      tools: [claimsRead('create_event')],
      services: servicesWithGrants([]),
      firstParty: true,
    }).toolCallInfo({ name: 'create_event', arguments: ARGS });
    expect(info).toMatchObject({ tier: 3, tier_reason: 'connector_calendar_write', is_approval_required: true });
  });

  it('ignores an "Always allow" grant recorded for the tool before this rule existed', async () => {
    const info = await makeToolSet({
      tools: [claimsRead('create_event')],
      services: servicesWithGrants(['create_event']),
    }).toolCallInfo({ name: 'create_event', arguments: ARGS });
    expect(info).toMatchObject({ tier: 3, tier_reason: 'connector_calendar_write', is_approval_required: true });
  });

  it('still runs a calendar read the connector declares read-only once it is always allowed', async () => {
    const info = await makeToolSet({
      tools: [claimsRead('list_events')],
      services: servicesWithGrants(['list_events']),
    }).toolCallInfo({ name: 'list_events', arguments: {} });
    expect(info).toMatchObject({ tier: 1, is_approval_required: false });
  });
});

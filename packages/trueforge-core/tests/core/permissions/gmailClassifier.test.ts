import { classifyTier, type ClassifyContext, type SentinelAction } from '../../../src/core/permissions/classifier';
import { defaultSentinelServices, type SentinelServices } from '../../../src/core/permissions/context';
import { createWebSearchTurnState } from '../../../src/core/permissions/webSearch';

function makeCtx(overrides: { services?: SentinelServices } = {}): ClassifyContext {
  return {
    services: overrides.services ?? defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
    tenant_id: 't1',
    created_by: 'u1',
    conversation_id: 'c1',
    repository_id: null,
    workspace_cwd: null,
    agent_intent: null,
    web_search: createWebSearchTurnState(),
  };
}

function gmailAction(tool_name: string, canonical_params: Record<string, unknown> = {}): SentinelAction {
  return {
    tool_name,
    canonical_params,
    tool_type: 'truefoundry-system',
    mcp_server_name: 'gmail',
    mcp_hints: { read_only_hint: true, open_world_hint: true },
  };
}

const READ_TOOLS = [
  'list_inbox_threads',
  'get_thread',
  'read_email',
  'download_attachment',
  'list_drafts',
  'get_draft',
];

describe('Gmail read classification', () => {
  it.each(READ_TOOLS)('runs %s silently and flags it as a sensitive read', async name => {
    const decision = await classifyTier(gmailAction(name), makeCtx());
    expect(decision).toMatchObject({ tier: 1, sensitive_read: true, card: null, auto_deny: null });
  });

  it('marks the turn as having read private data', async () => {
    const ctx = makeCtx();
    expect(ctx.web_search.privateDataRead).toBe(false);
    await classifyTier(gmailAction('read_email', { messageId: 'm1' }), ctx);
    expect(ctx.web_search.privateDataRead).toBe(true);
  });

  it('is denied while offline, because Gmail needs the network', async () => {
    const services = {
      ...defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
      isOffline: () => Promise.resolve(true),
    };
    const decision = await classifyTier(gmailAction('read_email'), makeCtx({ services }));
    expect(decision.auto_deny).toBe('offline_mode');
  });

  it('does not treat a connector tool of the same name as Gmail', async () => {
    const connectorTool: SentinelAction = {
      tool_name: 'read_email',
      canonical_params: {},
      tool_type: 'mcp',
      mcp_server_name: 'some-connector',
      mcp_hints: {},
    };
    const ctx = makeCtx();
    const decision = await classifyTier(connectorTool, ctx);
    expect(decision.tier).toBe(3);
    expect(ctx.web_search.privateDataRead).toBe(false);
  });

  it('does not let a built-in tool of another server take the Gmail path', async () => {
    const other: SentinelAction = { ...gmailAction('read_email'), mcp_server_name: 'notes' };
    const ctx = makeCtx();
    await classifyTier(other, ctx);
    expect(ctx.web_search.privateDataRead).toBe(false);
  });
});

import { classifyTier, type ClassifyContext, type SentinelAction } from '../../../src/core/permissions/classifier';
import { defaultSentinelServices } from '../../../src/core/permissions/context';
import { createWebSearchTurnState } from '../../../src/core/permissions/webSearch';

function makeCtx(): ClassifyContext {
  return {
    services: defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
    tenant_id: 't1',
    created_by: 'u1',
    conversation_id: 'c1',
    repository_id: null,
    workspace_cwd: null,
    agent_intent: null,
    web_search: createWebSearchTurnState(),
  };
}

function setupAction(tool_name: string): SentinelAction {
  return {
    tool_name,
    canonical_params: {},
    tool_type: 'truefoundry-system',
    mcp_server_name: 'google_setup',
    mcp_hints: { read_only_hint: true, destructive_hint: false, open_world_hint: false },
  };
}

describe('Google setup tool classification', () => {
  it('reads the connection state without asking, and not as a sensitive read', async () => {
    const decision = await classifyTier(setupAction('google_setup_status'), makeCtx());
    expect(decision).toMatchObject({ tier: 1, reason: 'google_setup_read', sensitive_read: false, auto_deny: null });
  });

  it('fails closed on a setup tool it does not know', async () => {
    const decision = await classifyTier(setupAction('google_setup_connect'), makeCtx());
    expect(decision).toMatchObject({ tier: 3, reason: 'unclassified' });
  });
});

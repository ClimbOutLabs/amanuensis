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

function action(tool_name: string, mcp_server_name = 'memory_pages'): SentinelAction {
  return {
    tool_name,
    canonical_params: { about: 'Nora' },
    tool_type: 'truefoundry-system',
    mcp_server_name,
    mcp_hints: { read_only_hint: false, destructive_hint: false, open_world_hint: false },
  };
}

describe('memory page tool classification', () => {
  it.each(['remember_fact', 'update_fact', 'forget_fact'])('runs %s without a card', async name => {
    const decision = await classifyTier(action(name), makeCtx());
    expect(decision).toMatchObject({ tier: 1, reason: 'memory_page_write', auto_deny: null, card: null });
  });

  it.each(['list_pages', 'read_page'])('runs %s without a card, as a read', async name => {
    const decision = await classifyTier(action(name), makeCtx());
    expect(decision).toMatchObject({ tier: 1, reason: 'memory_page_read', auto_deny: null, card: null });
  });

  it('fails closed on any other name on that server', async () => {
    const decision = await classifyTier(action('delete_everything'), makeCtx());
    expect(decision.tier).not.toBe(1);
  });

  it('gives a connector that only shares a tool name no free pass', async () => {
    const decision = await classifyTier(action('remember_fact', 'some-connector'), makeCtx());
    expect(decision.reason).not.toBe('memory_page_write');
  });
});

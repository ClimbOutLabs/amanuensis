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

function offerAction(tool_name: string): SentinelAction {
  return {
    tool_name,
    canonical_params: {},
    tool_type: 'truefoundry-system',
    mcp_server_name: 'email_offer',
    mcp_hints: { read_only_hint: true, destructive_hint: false, open_world_hint: false },
  };
}

describe('Email offer tool classification', () => {
  it('reads the connection state without asking, and not as a sensitive read', async () => {
    const decision = await classifyTier(offerAction('email_connection_status'), makeCtx());
    expect(decision).toMatchObject({ tier: 1, reason: 'email_offer_read', sensitive_read: false, auto_deny: null });
  });

  it('records the decline without asking, because the person just gave that answer', async () => {
    const decision = await classifyTier(offerAction('record_email_offer_decline'), makeCtx());
    expect(decision).toMatchObject({
      tier: 1,
      reason: 'email_offer_decline',
      sensitive_read: false,
      auto_deny: null,
    });
  });

  it('fails closed on an offer tool it does not know', async () => {
    const decision = await classifyTier(offerAction('email_offer_connect'), makeCtx());
    expect(decision).toMatchObject({ tier: 3, reason: 'unclassified' });
  });
});

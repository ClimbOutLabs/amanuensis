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

function personaAction(tool_name: string): SentinelAction {
  return {
    tool_name,
    canonical_params: {},
    tool_type: 'truefoundry-system',
    mcp_server_name: 'personas',
    mcp_hints: { read_only_hint: true, destructive_hint: false, open_world_hint: false },
  };
}

describe('Persona tool classification', () => {
  it('reads the persona list without asking', async () => {
    const decision = await classifyTier(personaAction('list_personas'), makeCtx());
    expect(decision).toMatchObject({ tier: 1, reason: 'persona_read', auto_deny: null });
  });

  it('switches the chat to an existing persona without asking', async () => {
    const decision = await classifyTier(personaAction('use_persona'), makeCtx());
    expect(decision).toMatchObject({ tier: 1, reason: 'persona_switch', auto_deny: null });
  });

  it('fails closed on a persona tool it does not know', async () => {
    const decision = await classifyTier(personaAction('rename_persona'), makeCtx());
    expect(decision).toMatchObject({ tier: 3, reason: 'unclassified' });
  });
});

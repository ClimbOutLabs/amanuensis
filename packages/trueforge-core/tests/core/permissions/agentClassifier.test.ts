import { classifyTier, type ClassifyContext, type SentinelAction } from '../../../src/core/permissions/classifier';
import { defaultSentinelServices } from '../../../src/core/permissions/context';
import type { Tier3Agent } from '../../../src/core/permissions/tier';
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

const MORNING_BRIEF_AGENT: Tier3Agent = {
  name: 'morning-brief',
  description: 'Reads my calendar and mail each morning.',
  instructions: 'Summarise today in five lines.',
  model_name: 'openai/gpt-5',
  connectors: ['calendar', 'mail'],
  skills: [],
  sandbox_enabled: false,
};

function agentAction(tool_name: string, agent_write?: Tier3Agent): SentinelAction {
  return {
    tool_name,
    canonical_params: { name: 'morning-brief' },
    tool_type: 'truefoundry-system',
    mcp_server_name: 'agents',
    mcp_hints: { read_only_hint: false, destructive_hint: false, open_world_hint: false },
    ...(agent_write === undefined ? {} : { agent_write }),
  };
}

describe('Agent tool classification', () => {
  it('asks before saving, with the agent in plain words', async () => {
    const decision = await classifyTier(agentAction('create_agent', MORNING_BRIEF_AGENT), makeCtx());
    expect(decision).toMatchObject({ tier: 3, reason: 'agent_write', auto_deny: null });
    expect(decision.approval_token_id).not.toBeNull();
    expect(decision.card?.plain_what).toBe('Save an agent: morning-brief? Reads my calendar and mail each morning.');
    expect(decision.card?.agent).toEqual(MORNING_BRIEF_AGENT);
  });

  it('shows the full setup, not only the first line', async () => {
    const decision = await classifyTier(
      agentAction('create_agent', { ...MORNING_BRIEF_AGENT, instructions: 'Line one.\nLine two.' }),
      makeCtx(),
    );
    expect(decision.card?.agent?.instructions).toBe('Line one.\nLine two.');
  });

  it('refuses a save the host could not show', async () => {
    const decision = await classifyTier(agentAction('create_agent'), makeCtx());
    expect(decision).toMatchObject({ tier: 3, auto_deny: 'destination_unverifiable', card: null });
  });

  it('fails closed on an agent tool it does not know', async () => {
    const decision = await classifyTier(agentAction('delete_agent', MORNING_BRIEF_AGENT), makeCtx());
    expect(decision.tier).toBe(3);
    expect(decision.reason).not.toBe('agent_write');
    expect(decision.card).toBeNull();
  });
});

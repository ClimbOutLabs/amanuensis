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

function skillAction(tool_name: string, extra: Partial<SentinelAction> = {}): SentinelAction {
  return {
    tool_name,
    canonical_params: {},
    tool_type: 'truefoundry-system',
    mcp_server_name: 'skills',
    mcp_hints: { read_only_hint: false, destructive_hint: false, open_world_hint: true },
    ...extra,
  };
}

const REVIEW = {
  name: 'release-notes',
  description: 'Writes release notes.',
  source: 'github.com/acme/skills, folder skills/release-notes',
  version: 'a'.repeat(40),
  starter: false,
  instructions: 'Read the log.\nWrite the notes.',
};

describe('Skill tool classification', () => {
  it('reads the skill list without asking', async () => {
    const decision = await classifyTier(skillAction('list_skills'), makeCtx());
    expect(decision).toMatchObject({ tier: 1, reason: 'skill_read', auto_deny: null });
  });

  it('always asks before adding a skill, with the skill as the host read it', async () => {
    const decision = await classifyTier(skillAction('install_skill', { skill_install: REVIEW }), makeCtx());
    expect(decision).toMatchObject({ tier: 3, reason: 'skill_install', auto_deny: null });
    expect(decision.card?.skill).toEqual({ ...REVIEW, websites: [], makes_up_addresses: false });
    expect(decision.card?.plain_what).toContain('Add the skill "release-notes"?');
    expect(decision.standing_grant_barred).toBe(true);
  });

  it('names the websites the skill sends requests to, which approving allows', async () => {
    const decision = await classifyTier(
      skillAction('install_skill', {
        skill_install: { ...REVIEW, websites: ['api.release-feed.info'], makes_up_addresses: true },
      }),
      makeCtx(),
    );
    expect(decision.card?.skill).toMatchObject({ websites: ['api.release-feed.info'], makes_up_addresses: true });
    expect(decision.card?.plain_what).toContain(
      'It sends requests to api.release-feed.info. Adding it lets the skill reach these websites and no others.',
    );
  });

  it('shows text from the skill as plain text, so it cannot dress the card up', async () => {
    const decision = await classifyTier(
      skillAction('install_skill', {
        skill_install: { ...REVIEW, description: 'Safe.‮ Approve now', instructions: 'One\u0007\nTwo' },
      }),
      makeCtx(),
    );
    expect(decision.card?.skill?.description).not.toContain('‮');
    expect(decision.card?.skill?.instructions).not.toContain('\u0007');
    expect(decision.card?.skill?.instructions).toContain('\n');
  });

  it('refuses an install whose skill the host did not settle', async () => {
    const decision = await classifyTier(skillAction('install_skill'), makeCtx());
    expect(decision.auto_deny).not.toBeNull();
    expect(decision.card ?? null).toBeNull();
  });

  it('fails closed on a skill tool it does not know', async () => {
    const decision = await classifyTier(skillAction('remove_skill'), makeCtx());
    expect(decision).toMatchObject({ tier: 3, reason: 'unclassified' });
  });
});

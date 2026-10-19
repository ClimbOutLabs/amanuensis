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

function spaceAction(tool_name: string, canonical_params: Record<string, unknown> = {}): SentinelAction {
  return {
    tool_name,
    canonical_params,
    tool_type: 'truefoundry-system',
    mcp_server_name: 'space',
    mcp_hints: { read_only_hint: false, destructive_hint: false, open_world_hint: false },
  };
}

describe('Space tool classification', () => {
  it('runs create_space without asking and names the space', async () => {
    const decision = await classifyTier(spaceAction('create_space', { name: 'Home renovation' }), makeCtx());
    expect(decision).toMatchObject({ tier: 1, reason: 'space_write', card: null, auto_deny: null });
    expect(decision.reason_detail).toBe('Created space: Home renovation');
  });

  it('runs update_space without asking and names the space', async () => {
    const decision = await classifyTier(
      spaceAction('update_space', { space_id: 'sp1', name: 'Home renovation' }),
      makeCtx(),
    );
    expect(decision).toMatchObject({ tier: 1, reason: 'space_write', card: null, auto_deny: null });
    expect(decision.reason_detail).toBe('Updated space: Home renovation');
  });

  it('runs update_space without asking when the call carries no name', async () => {
    const decision = await classifyTier(
      spaceAction('update_space', { space_id: 'sp1', edits: [{ search: 'old', replace: 'new' }] }),
      makeCtx(),
    );
    expect(decision).toMatchObject({ tier: 1, reason: 'space_write', card: null, auto_deny: null });
    expect(decision.reason_detail).toBe('Updated a space.');
  });

  it('shows a name with newlines and tabs as one line', async () => {
    const decision = await classifyTier(spaceAction('create_space', { name: 'Home\nrenovation\tplans' }), makeCtx());
    expect(decision).toMatchObject({ tier: 1, reason: 'space_write', card: null, auto_deny: null });
    expect(decision.reason_detail).toBe('Created space: Home renovation plans');
  });

  it('trims the padding around the name it shows', async () => {
    const decision = await classifyTier(spaceAction('create_space', { name: '  Home renovation  ' }), makeCtx());
    expect(decision.reason_detail).toBe('Created space: Home renovation');
  });

  it('caps a long name in the line it shows', async () => {
    const decision = await classifyTier(spaceAction('create_space', { name: 'a'.repeat(500) }), makeCtx());
    expect(decision.reason_detail).toBe(`Created space: ${'a'.repeat(79)}…`);
  });

  it('shows the nameless line when the name is only whitespace', async () => {
    const decision = await classifyTier(spaceAction('update_space', { space_id: 'sp1', name: ' \n\t ' }), makeCtx());
    expect(decision).toMatchObject({ tier: 1, reason: 'space_write', card: null, auto_deny: null });
    expect(decision.reason_detail).toBe('Updated a space.');
  });

  it('runs revert_space without asking', async () => {
    const decision = await classifyTier(spaceAction('revert_space', { space_id: 'sp1', revision: 2 }), makeCtx());
    expect(decision).toMatchObject({ tier: 1, reason: 'space_write', card: null, auto_deny: null });
    expect(decision.reason_detail).toBe('Restored a space to an earlier version.');
  });

  it.each(['list_spaces', 'get_space', 'list_blocks'])('runs %s without asking', async name => {
    const decision = await classifyTier(spaceAction(name), makeCtx());
    expect(decision).toMatchObject({ tier: 1, reason: 'space_read', card: null, auto_deny: null });
  });

  it('fails closed on an unknown space tool', async () => {
    const decision = await classifyTier(spaceAction('wipe_spaces'), makeCtx());
    expect(decision).toMatchObject({ tier: 3, reason: 'unclassified', card: null });
    expect(decision.reason_detail).toBe('Unknown space tool.');
  });

  it('still asks for a create_space from another server', async () => {
    const action: SentinelAction = {
      ...spaceAction('create_space', { name: 'Home renovation' }),
      tool_type: 'mcp',
      mcp_server_name: 'some-other-server',
    };
    const decision = await classifyTier(action, makeCtx());
    expect(decision.tier).toBe(3);
    expect(decision.reason).not.toBe('space_write');
    expect(decision.card?.plain_what).toBe("Aman doesn't know this tool yet: create_space.");
  });
});

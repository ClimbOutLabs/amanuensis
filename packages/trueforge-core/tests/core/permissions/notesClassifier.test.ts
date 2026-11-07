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

function notesAction(tool_name: string): SentinelAction {
  return {
    tool_name,
    canonical_params: {},
    tool_type: 'truefoundry-system',
    mcp_server_name: 'notes_folder',
    mcp_hints: { read_only_hint: false, destructive_hint: false, open_world_hint: false },
  };
}

describe('Notes folder tool classification', () => {
  it('searches the notes without asking, as a sensitive read', async () => {
    const decision = await classifyTier(notesAction('search_notes'), makeCtx());
    expect(decision).toMatchObject({ tier: 1, reason: 'notes_read', auto_deny: null, sensitive_read: true });
  });

  it('reads one note without asking, as a sensitive read', async () => {
    const decision = await classifyTier(notesAction('read_note'), makeCtx());
    expect(decision).toMatchObject({ tier: 1, reason: 'notes_read', auto_deny: null, sensitive_read: true });
  });

  it('adds an entry to the inbox without asking: it can only add, never change a written word', async () => {
    const decision = await classifyTier(notesAction('append_to_inbox'), makeCtx());
    expect(decision).toMatchObject({ tier: 1, reason: 'notes_write', auto_deny: null });
  });

  it('makes a new note without asking, for the same reason', async () => {
    const decision = await classifyTier(notesAction('create_note'), makeCtx());
    expect(decision).toMatchObject({ tier: 1, reason: 'notes_write', auto_deny: null });
  });

  it('fails closed on a notes tool it does not know, such as an edit', async () => {
    const decision = await classifyTier(notesAction('edit_note'), makeCtx());
    expect(decision).toMatchObject({ tier: 3, reason: 'unclassified' });
  });

  it('fails closed on a delete under the notes name', async () => {
    const decision = await classifyTier(notesAction('delete_note'), makeCtx());
    expect(decision).toMatchObject({ tier: 3, reason: 'unclassified' });
  });
});

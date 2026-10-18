import { makeAgentSpec } from '../../../../../trueforge-core/tests/agent-session/testHelpers';
import { SentinelAuditStore } from '../../../../src/db/sentinelAuditStore';
import { SqliteSessionStore } from '../../../../src/db/sqlite/session-store/SqliteSessionStore';
import { createSqliteTestDatabase, type SqliteTestDatabase } from '../testDatabase';

describe('SentinelAuditStore', () => {
  let env: SqliteTestDatabase;
  let store: SentinelAuditStore;

  beforeEach(async () => {
    env = await createSqliteTestDatabase();
    store = new SentinelAuditStore(env.db);
  }, 120_000);

  afterEach(async () => {
    await env?.teardown();
  });

  it('record persists an entry and list returns it', async () => {
    await store.record({
      tenant_id: 't1',
      created_by: 'u1',
      conversation_id: 's1',
      tier: 3,
      tool_name: 'update_space',
      description: 'Update space',
      outcome: 'ran',
      auto_deny_reason: null,
    });

    const rows = await store.list({
      tenant_id: 't1',
      created_by: 'u1',
      conversation_id: 's1',
      limit: 50,
      offset: 0,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]!.tool_name).toBe('update_space');
    expect(rows[0]!.tier).toBe(3);
    expect(rows[0]!.outcome).toBe('ran');
    expect(rows[0]!.id).toBeDefined();
    expect(rows[0]!.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('list is scoped by tenant, user, and session', async () => {
    await store.record({
      tenant_id: 't1',
      created_by: 'u1',
      conversation_id: 's1',
      tier: 1,
      tool_name: 'read',
      description: 'read',
      outcome: 'logged',
      auto_deny_reason: null,
    });
    await store.record({
      tenant_id: 't1',
      created_by: 'u1',
      conversation_id: 's2',
      tier: 2,
      tool_name: 'write',
      description: 'write',
      outcome: 'ran',
      auto_deny_reason: null,
    });

    const s1 = await store.list({ tenant_id: 't1', created_by: 'u1', conversation_id: 's1', limit: 50, offset: 0 });
    expect(s1).toHaveLength(1);
    expect(s1[0]!.tool_name).toBe('read');

    const otherTenant = await store.list({
      tenant_id: 't2',
      created_by: 'u1',
      conversation_id: 's1',
      limit: 50,
      offset: 0,
    });
    expect(otherTenant).toHaveLength(0);
  });

  it('list orders by created_at desc and paginates', async () => {
    for (let i = 0; i < 3; i++) {
      await store.record({
        tenant_id: 't1',
        created_by: 'u1',
        conversation_id: 's1',
        tier: 1,
        tool_name: `tool_${i}`,
        description: `tool ${i}`,
        outcome: 'logged',
        auto_deny_reason: null,
      });
      await new Promise(r => setTimeout(r, 10));
    }

    const page1 = await store.list({ tenant_id: 't1', created_by: 'u1', conversation_id: 's1', limit: 2, offset: 0 });
    expect(page1).toHaveLength(2);
    expect(page1[0]!.tool_name).toBe('tool_2');

    const page2 = await store.list({ tenant_id: 't1', created_by: 'u1', conversation_id: 's1', limit: 2, offset: 2 });
    expect(page2).toHaveLength(1);
    expect(page2[0]!.tool_name).toBe('tool_0');
  });

  it('keeps the record of an approved calendar write after its chat is deleted', async () => {
    const sessions = new SqliteSessionStore(env.db);
    await sessions.createSession({
      tenant_id: 't1',
      session_id: 's-cal',
      created_by_subject: { subject_id: 'u1', subject_type: 'user', subject_display_name: 'u1' },
      external_id: null,
      source: null,
      metadata: {},
      agent: { type: 'inline', spec: makeAgentSpec() },
      custom: null,
    });
    await store.record({
      tenant_id: 't1',
      created_by: 'u1',
      conversation_id: 's-cal',
      tier: 3,
      tool_name: 'create_event',
      description:
        'Add "Dentist" to your Google Calendar on Monday, October 19, 2026, 9:00 am to 10:00 am (America/New_York).',
      outcome: 'approved',
      auto_deny_reason: null,
    });

    await sessions.deleteSession({ tenant_id: 't1', session_id: 's-cal' });

    expect(await sessions.getSession({ tenant_id: 't1', session_id: 's-cal' })).toBeUndefined();
    const rows = await store.list({
      tenant_id: 't1',
      created_by: 'u1',
      conversation_id: 's-cal',
      limit: 50,
      offset: 0,
    });
    expect(rows.map(row => ({ tool_name: row.tool_name, outcome: row.outcome }))).toEqual([
      { tool_name: 'create_event', outcome: 'approved' },
    ]);
    expect(rows[0]?.description).toContain('Dentist');
  });
});

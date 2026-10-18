/**
 * Backend-agnostic behavioural contract for ISentinelAuditStore.
 * Runs under jest against a fresh store per test (see backend test files).
 */
import type { ISessionStore } from '@truefoundry/trueforge-core/agent-session';
import type { AuditRecordInput } from '@truefoundry/trueforge-core/core';

import { makeAgentSpec } from '../../../trueforge-core/tests/agent-session/testHelpers';
import type { ISentinelAuditStore } from '../../src/db/sentinelAuditStore';

export interface SentinelAuditStoreContractEnv {
  store: ISentinelAuditStore;
  sessions: Pick<ISessionStore, 'createSession' | 'deleteSession' | 'getSession'>;
}

function entry(overrides: Partial<AuditRecordInput>): AuditRecordInput {
  return {
    tenant_id: 't1',
    created_by: 'u1',
    conversation_id: 's1',
    tier: 1,
    tool_name: 'read',
    description: 'Read a file',
    outcome: 'logged',
    auto_deny_reason: null,
    ...overrides,
  };
}

// Timestamps are millisecond-precise; spacing writes keeps "newest first" deterministic.
async function recordInOrder(store: ISentinelAuditStore, inputs: AuditRecordInput[]): Promise<void> {
  for (const input of inputs) {
    await store.record(input);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function createChat(env: SentinelAuditStoreContractEnv, sessionId: string): Promise<void> {
  await env.sessions.createSession({
    tenant_id: 't1',
    session_id: sessionId,
    created_by_subject: { subject_id: 'u1', subject_type: 'user', subject_display_name: 'u1' },
    external_id: null,
    source: null,
    metadata: {},
    agent: { type: 'inline', spec: makeAgentSpec() },
    custom: null,
  });
}

const forUser = { tenant_id: 't1', created_by: 'u1', outcome: undefined, page_token: undefined };

export function runSentinelAuditStoreContractSuite(getEnv: () => SentinelAuditStoreContractEnv): void {
  it('list returns one chat’s entries, newest first, paged by offset', async () => {
    const { store } = getEnv();
    await recordInOrder(store, [
      entry({ tool_name: 'tool_0' }),
      entry({ tool_name: 'tool_1' }),
      entry({ tool_name: 'other_chat', conversation_id: 's2' }),
      entry({ tool_name: 'tool_2' }),
    ]);

    const page1 = await store.list({ tenant_id: 't1', created_by: 'u1', conversation_id: 's1', limit: 2, offset: 0 });
    const page2 = await store.list({ tenant_id: 't1', created_by: 'u1', conversation_id: 's1', limit: 2, offset: 2 });

    expect(page1.map(row => row.tool_name)).toEqual(['tool_2', 'tool_1']);
    expect(page2.map(row => row.tool_name)).toEqual(['tool_0']);
    expect(page1[0]?.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  });

  it('keeps the record of an approved calendar write after its chat is deleted', async () => {
    const env = getEnv();
    await createChat(env, 's-cal');
    await env.store.record(
      entry({
        conversation_id: 's-cal',
        tier: 3,
        tool_name: 'create_event',
        description:
          'Add "Dentist" to your Google Calendar on Monday, October 19, 2026, 9:00 am to 10:00 am (America/New_York).',
        outcome: 'approved',
      }),
    );

    await env.sessions.deleteSession({ tenant_id: 't1', session_id: 's-cal' });

    expect(await env.sessions.getSession({ tenant_id: 't1', session_id: 's-cal' })).toBeUndefined();
    const rows = await env.store.list({
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

  it('listForUser spans every chat and marks entries whose chat was deleted', async () => {
    const env = getEnv();
    await createChat(env, 'kept');
    await createChat(env, 'gone');
    await recordInOrder(env.store, [
      entry({ conversation_id: 'gone', tool_name: 'send_email', outcome: 'approved', tier: 3 }),
      entry({ conversation_id: 'kept', tool_name: 'write_file', outcome: 'ran', tier: 2 }),
      entry({ conversation_id: 'never-stored', tool_name: 'search' }),
    ]);
    await env.sessions.deleteSession({ tenant_id: 't1', session_id: 'gone' });

    const page = await env.store.listForUser({ ...forUser, limit: 10 });

    expect(page.next_page_token).toBeUndefined();
    expect(page.entries.map(row => [row.tool_name, row.conversation_id, row.chat_exists])).toEqual([
      ['search', 'never-stored', false],
      ['write_file', 'kept', true],
      ['send_email', 'gone', false],
    ]);
    expect(page.entries[2]).toMatchObject({ outcome: 'approved', tier: 3, description: 'Read a file' });
  });

  it('listForUser never returns another user’s or another tenant’s entries', async () => {
    const { store } = getEnv();
    await recordInOrder(store, [
      entry({ tool_name: 'mine' }),
      entry({ tool_name: 'theirs', created_by: 'u2' }),
      entry({ tool_name: 'other_tenant', tenant_id: 't2' }),
    ]);

    const mine = await store.listForUser({ ...forUser, limit: 10 });
    const theirs = await store.listForUser({ ...forUser, created_by: 'u2', limit: 10 });

    expect(mine.entries.map(row => row.tool_name)).toEqual(['mine']);
    expect(theirs.entries.map(row => row.tool_name)).toEqual(['theirs']);
  });

  it('listForUser pages with a token until the log is exhausted', async () => {
    const { store } = getEnv();
    await recordInOrder(
      store,
      ['a', 'b', 'c', 'd', 'e'].map(name => entry({ tool_name: name, conversation_id: `chat-${name}` })),
    );

    const seen: string[] = [];
    let pageToken: string | undefined;
    let pages = 0;
    do {
      const page = await store.listForUser({ ...forUser, limit: 2, page_token: pageToken });
      seen.push(...page.entries.map(row => row.tool_name));
      pageToken = page.next_page_token;
      pages += 1;
    } while (pageToken !== undefined);

    expect(pages).toBe(3);
    expect(seen).toEqual(['e', 'd', 'c', 'b', 'a']);
  });

  it('listForUser filters by outcome', async () => {
    const { store } = getEnv();
    await recordInOrder(store, [
      entry({ tool_name: 'denied_1', outcome: 'denied' }),
      entry({ tool_name: 'ran_1', outcome: 'ran' }),
      entry({ tool_name: 'denied_2', outcome: 'denied' }),
    ]);

    const page = await store.listForUser({ ...forUser, outcome: 'denied', limit: 10 });

    expect(page.entries.map(row => row.tool_name)).toEqual(['denied_2', 'denied_1']);
  });
}

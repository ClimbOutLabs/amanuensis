import { createSentinelHostContext } from '@truefoundry/trueforge-core/core';
import type { GoogleConnectionRecord } from '@truefoundry/trueforge-core/core/google/connection';
import { defaultSentinelServices, forUnattendedRun } from '@truefoundry/trueforge-core/core/permissions/context';
import { NOOP_AGENT_TRACING } from '@truefoundry/trueforge-core/core/tracing/NoopAgentTracing';
import { SqliteGoogleConnectionStore } from '../../../src/db/sqlite/google-connection-store/SqliteGoogleConnectionStore';
import { calendarCapability } from '../../../src/runtime/calendarCapability';
import { createSqliteTestDatabase, type SqliteTestDatabase } from '../../db/sqlite/testDatabase';

const OWNER = { tenant_id: 't1', created_by: 'ada' };
const READ = 'https://www.googleapis.com/auth/gmail.readonly';
const COMPOSE = 'https://www.googleapis.com/auth/gmail.compose';
const CALENDAR = 'https://www.googleapis.com/auth/calendar.events.readonly';

function record(overrides: Partial<GoogleConnectionRecord> = {}): GoogleConnectionRecord {
  return {
    ...OWNER,
    client_id: '123456789-abcdefghij.apps.googleusercontent.com',
    client_secret: 'secret',
    client_type: 'desktop',
    refresh_token: 'rt',
    granted_scopes: [READ, CALENDAR],
    account_email: 'ada@example.com',
    status: 'connected',
    created_at: '2026-10-15T00:00:00.000Z',
    updated_at: '2026-10-15T00:00:00.000Z',
    ...overrides,
  };
}

async function toolNames(capability: Awaited<ReturnType<typeof calendarCapability>>): Promise<string[]> {
  const sets = capability?.systemToolSets ?? [];
  const listed = await Promise.all(sets.map(set => set.listTools()));
  return listed.flatMap(response => ('result' in response ? response.result.tools.map(tool => tool.name) : []));
}

describe('calendarCapability', () => {
  let env: SqliteTestDatabase;
  let store: SqliteGoogleConnectionStore;

  const mount = (owner = OWNER, unattended = false) =>
    calendarCapability({
      connections: store,
      owner,
      tracing: NOOP_AGENT_TRACING,
      timeZone: 'America/Sao_Paulo',
      sentinel: createSentinelHostContext({
        ...owner,
        conversation_id: 'c1',
        services: unattended
          ? forUnattendedRun(defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }))
          : defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
      }),
      fetchImpl: () => Promise.reject(new Error('no network in this test')),
    });

  beforeEach(async () => {
    env = await createSqliteTestDatabase();
    store = new SqliteGoogleConnectionStore(env.db);
  }, 120_000);

  afterEach(async () => {
    await env.teardown();
  });

  it('mounts nothing for a user who never connected', async () => {
    expect(await mount()).toBeUndefined();
  });

  it('mounts the two reading tools once Calendar is granted', async () => {
    await store.save(record());
    expect(await toolNames(await mount())).toEqual(['list_events', 'get_event']);
  });

  it('mounts nothing for a mail-only login, so chat does not offer a calendar it cannot read', async () => {
    await store.save(record({ granted_scopes: [READ, COMPOSE] }));
    expect(await mount()).toBeUndefined();
  });

  it('mounts nothing while the login needs reconnecting', async () => {
    await store.save(record({ status: 'needs_reconnect' }));
    expect(await mount()).toBeUndefined();
  });

  it('never mounts one user login for another', async () => {
    await store.save(record());
    expect(await mount({ ...OWNER, created_by: 'grace' })).toBeUndefined();
  });

  it('offers a scheduled run the same reading tools and nothing that writes', async () => {
    await store.save(record({ granted_scopes: [READ, COMPOSE, CALENDAR] }));
    expect(await toolNames(await mount(OWNER, true))).toEqual(['list_events', 'get_event']);
  });
});

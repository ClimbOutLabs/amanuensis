import { createSentinelHostContext } from '@truefoundry/trueforge-core/core';
import type { GoogleConnectionRecord } from '@truefoundry/trueforge-core/core/google/connection';
import { defaultSentinelServices, forUnattendedRun } from '@truefoundry/trueforge-core/core/permissions/context';
import { NOOP_AGENT_TRACING } from '@truefoundry/trueforge-core/core/tracing/NoopAgentTracing';
import path from 'node:path';
import { createLogger } from 'winston';
import { SqliteGoogleConnectionStore } from '../../../src/db/sqlite/google-connection-store/SqliteGoogleConnectionStore';
import { buildEvalSources } from '../../../src/eval/fixtures';
import { googleCapability } from '../../../src/runtime/googleCapability';
import { createSqliteTestDatabase, type SqliteTestDatabase } from '../../db/sqlite/testDatabase';

const OWNER = { tenant_id: 't1', created_by: 'ada' };
const EVAL_FIXTURE_DIR = path.resolve(__dirname, '..', '..', '..', 'evals', 'fixtures');
const READ = 'https://www.googleapis.com/auth/gmail.readonly';
const COMPOSE = 'https://www.googleapis.com/auth/gmail.compose';

function record(overrides: Partial<GoogleConnectionRecord> = {}): GoogleConnectionRecord {
  return {
    ...OWNER,
    client_id: '123456789-abcdefghij.apps.googleusercontent.com',
    client_secret: 'secret',
    client_type: 'desktop',
    refresh_token: 'rt',
    granted_scopes: [READ],
    account_email: 'ada@example.com',
    status: 'connected',
    created_at: '2026-10-15T00:00:00.000Z',
    updated_at: '2026-10-15T00:00:00.000Z',
    ...overrides,
  };
}

async function toolNames(capability: Awaited<ReturnType<typeof googleCapability>>): Promise<string[]> {
  const sets = capability?.systemToolSets ?? [];
  const listed = await Promise.all(sets.map(set => set.listTools()));
  return listed.flatMap(response => ('result' in response ? response.result.tools.map(tool => tool.name) : []));
}

describe('googleCapability for mail', () => {
  let env: SqliteTestDatabase;
  let store: SqliteGoogleConnectionStore;

  const mount = (owner = OWNER, unattended = false) =>
    googleCapability({
      connections: store,
      evalSources: undefined,
      owner,
      tracing: NOOP_AGENT_TRACING,
      sentinel: createSentinelHostContext({
        ...owner,
        conversation_id: 'c1',
        services: unattended
          ? forUnattendedRun(defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }))
          : defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
      }),
      attachmentStager: undefined,
      logger: createLogger({ silent: true }),
      timeZone: undefined,
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

  it('in eval mode mounts the fixture mail and calendar tools with no stored login', async () => {
    const capability = await googleCapability({
      connections: undefined,
      evalSources: buildEvalSources(EVAL_FIXTURE_DIR),
      owner: OWNER,
      tracing: NOOP_AGENT_TRACING,
      sentinel: createSentinelHostContext({
        ...OWNER,
        conversation_id: 'c1',
        services: defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
      }),
      attachmentStager: undefined,
      logger: createLogger({ silent: true }),
      timeZone: undefined,
      fetchImpl: () => Promise.reject(new Error('no network in eval mode')),
    });
    expect(await toolNames(capability)).toEqual(
      expect.arrayContaining(['read_email', 'draft_email', 'list_events', 'create_event']),
    );
  });

  it('mounts the read tools for a connected user', async () => {
    await store.save(record());
    expect(await toolNames(await mount())).toContain('read_email');
  });

  it('mounts nothing while the login needs reconnecting, so chat stops offering mail', async () => {
    await store.save(record({ status: 'needs_reconnect' }));
    expect(await mount()).toBeUndefined();
  });

  it('mounts nothing when Google did not grant mail access', async () => {
    await store.save(record({ granted_scopes: ['openid'] }));
    expect(await mount()).toBeUndefined();
    await store.save(record({ granted_scopes: [COMPOSE] }));
    expect(await mount()).toBeUndefined();
  });

  it('never mounts one user login for another', async () => {
    await store.save(record());
    expect(await mount({ ...OWNER, created_by: 'grace' })).toBeUndefined();
  });

  it('offers drafts and sends only to an attended turn that holds the compose grant', async () => {
    await store.save(record({ granted_scopes: [READ, COMPOSE] }));
    expect(await toolNames(await mount())).toEqual(
      expect.arrayContaining(['draft_email', 'update_draft', 'send_draft']),
    );
    const scheduled = await toolNames(await mount(OWNER, true));
    expect(scheduled).toContain('read_email');
    expect(scheduled).not.toContain('send_draft');
    expect(scheduled).not.toContain('draft_email');
  });

  it('offers no write tool with only the read grant', async () => {
    await store.save(record());
    expect(await toolNames(await mount())).not.toContain('send_draft');
  });
});

const CALENDAR = 'https://www.googleapis.com/auth/calendar.events.readonly';

async function calendarToolNames(capability: Awaited<ReturnType<typeof googleCapability>>): Promise<string[]> {
  const sets = (capability?.systemToolSets ?? []).filter(set => set.name === 'google_calendar');
  const listed = await Promise.all(sets.map(set => set.listTools()));
  return listed.flatMap(response => ('result' in response ? response.result.tools.map(tool => tool.name) : []));
}

describe('googleCapability for calendar', () => {
  let env: SqliteTestDatabase;
  let store: SqliteGoogleConnectionStore;

  const mount = (owner = OWNER, unattended = false) =>
    googleCapability({
      connections: store,
      evalSources: undefined,
      owner,
      tracing: NOOP_AGENT_TRACING,
      timeZone: 'America/Sao_Paulo',
      attachmentStager: undefined,
      logger: createLogger({ silent: true }),
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
    await store.save(record({ granted_scopes: [READ, CALENDAR] }));
    expect(await calendarToolNames(await mount())).toEqual(['list_events', 'get_event']);
  });

  it('mounts nothing for a mail-only login, so chat does not offer a calendar it cannot read', async () => {
    await store.save(record({ granted_scopes: [READ, COMPOSE] }));
    expect(await calendarToolNames(await mount())).toEqual([]);
  });

  it('mounts nothing while the login needs reconnecting', async () => {
    await store.save(record({ status: 'needs_reconnect' }));
    expect(await mount()).toBeUndefined();
  });

  it('never mounts one user login for another', async () => {
    await store.save(record({ granted_scopes: [READ, CALENDAR] }));
    expect(await mount({ ...OWNER, created_by: 'grace' })).toBeUndefined();
  });

  it('offers a scheduled run the same reading tools and nothing that writes', async () => {
    await store.save(record({ granted_scopes: [READ, COMPOSE, CALENDAR] }));
    expect(await calendarToolNames(await mount(OWNER, true))).toEqual(['list_events', 'get_event']);
  });

  it('mounts mail and calendar together from one read of the login', async () => {
    await store.save(record({ granted_scopes: [READ, CALENDAR] }));
    const reads = jest.spyOn(store, 'get');
    const capability = await mount();
    expect(reads).toHaveBeenCalledTimes(1);
    expect((capability?.systemToolSets ?? []).map(set => set.name)).toEqual(['gmail', 'google_calendar']);
  });
});

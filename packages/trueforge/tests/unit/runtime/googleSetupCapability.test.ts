import type { CallToolResponse } from '@truefoundry/trueforge-core/core';
import type { GoogleConnectionRecord } from '@truefoundry/trueforge-core/core/google/connection';
import { NOOP_AGENT_TRACING } from '@truefoundry/trueforge-core/core/tracing/NoopAgentTracing';
import { SqliteGoogleConnectionStore } from '../../../src/db/sqlite/google-connection-store/SqliteGoogleConnectionStore';
import { GOOGLE_SETUP_INSTRUCTION, googleSetupCapability } from '../../../src/runtime/googleSetupCapability';
import { createSqliteTestDatabase, type SqliteTestDatabase } from '../../db/sqlite/testDatabase';
import { isRecord } from '../../fixtures/jsonGuards';

const OWNER = { tenant_id: 't1', created_by: 'ada' };
const READ = 'https://www.googleapis.com/auth/gmail.readonly';
const COMPOSE = 'https://www.googleapis.com/auth/gmail.compose';
const CALENDAR_READ = 'https://www.googleapis.com/auth/calendar.events.readonly';
const CALENDAR_WRITE = 'https://www.googleapis.com/auth/calendar.events';

function record(overrides: Partial<GoogleConnectionRecord> = {}): GoogleConnectionRecord {
  return {
    ...OWNER,
    client_id: '123456789-abcdefghij.apps.googleusercontent.com',
    client_secret: 'test-secret-value',
    client_type: 'desktop',
    refresh_token: 'refresh-token',
    granted_scopes: [READ],
    account_email: 'ada@example.com',
    status: 'connected',
    created_at: '2026-10-15T00:00:00.000Z',
    updated_at: '2026-10-15T00:00:00.000Z',
    ...overrides,
  };
}

function textOf(response: CallToolResponse): string {
  if (!('result' in response)) {
    throw new Error('expected a tool result');
  }
  const content = response.result.content[0];
  return content?.type === 'text' ? content.text : '';
}

/** Guards for tool-result JSON, so the test never leans on an assertion escape. */
function parsedObject(text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) {
    throw new Error('expected a JSON object');
  }
  return parsed;
}

describe('googleSetupCapability', () => {
  let env: SqliteTestDatabase;
  let store: SqliteGoogleConnectionStore;

  beforeEach(async () => {
    env = await createSqliteTestDatabase();
    store = new SqliteGoogleConnectionStore(env.db);
  }, 120_000);

  afterEach(async () => {
    await env.teardown();
  });

  const mount = (owner = OWNER) => googleSetupCapability({ connections: store, owner, tracing: NOOP_AGENT_TRACING });

  async function statusResult(capability: Awaited<ReturnType<typeof mount>>): Promise<Record<string, unknown>> {
    const set = capability?.systemToolSets?.[0];
    if (set === undefined) {
      throw new Error('expected the setup tool set to be mounted');
    }
    return parsedObject(textOf(await set.callTool({ name: 'google_setup_status', arguments: {} })));
  }

  it('mounts the status read and no other tool for a user who never connected', async () => {
    const capability = await mount();
    const sets = capability?.systemToolSets ?? [];
    expect(sets).toHaveLength(1);
    const listed = await sets[0]?.listTools();
    const names = listed !== undefined && 'result' in listed ? listed.result.tools.map(tool => tool.name) : [];
    expect(names).toEqual(['google_setup_status']);
  });

  it('says not connected, with nothing granted and the setup as the next step', async () => {
    const result = await statusResult(await mount());
    expect(result['state']).toBe('not_connected');
    expect(result['account_email']).toBeNull();
    expect(result['has_saved_client']).toBe(false);
    const next = result['next_step'];
    expect(typeof next === 'string' && next.includes('Settings, then Connectors, then Google')).toBe(true);
  });

  it('follows the setup through: a login saved the way the Settings page saves it reads back connected', async () => {
    const before = await statusResult(await mount());
    expect(before['state']).toBe('not_connected');
    // The consent finishing on the Settings page saves exactly this record; the chat then confirms it.
    await store.save(record({ granted_scopes: [READ, COMPOSE] }));
    const after = await statusResult(await mount());
    expect(after['state']).toBe('connected');
    expect(after['account_email']).toBe('ada@example.com');
    expect(after['has_saved_client']).toBe(true);
    const features = after['features'];
    expect(Array.isArray(features)).toBe(true);
    const grantedByFeature = new Map(
      (Array.isArray(features) ? features : []).filter(isRecord).map(item => [item['feature'], item['granted']]),
    );
    expect(grantedByFeature.get('gmail_read')).toBe(true);
    expect(grantedByFeature.get('gmail_compose')).toBe(true);
    expect(grantedByFeature.get('calendar_read')).toBe(false);
    const next = after['next_step'];
    expect(typeof next === 'string' && next.includes('Still off')).toBe(true);
  });

  it('says an expired sign-in needs reconnecting', async () => {
    await store.save(record({ status: 'needs_reconnect' }));
    const result = await statusResult(await mount());
    expect(result['state']).toBe('needs_reconnect');
    const next = result['next_step'];
    expect(typeof next === 'string' && next.includes('Reconnect')).toBe(true);
  });

  it('mounts nothing once the login is connected with everything allowed', async () => {
    await store.save(record({ granted_scopes: [READ, COMPOSE, CALENDAR_READ, CALENDAR_WRITE] }));
    expect(await mount()).toBeUndefined();
  });

  it('mounts the walkthrough with the read for a user who never connected', async () => {
    const capability = await mount();
    expect(capability?.systemToolSets).toHaveLength(1);
    expect(capability?.instructionBuilders).toHaveLength(1);
  });

  it('mounts the read without the walkthrough once the login is connected with something still off', async () => {
    // The Cloud steps are done by then; what is still off is turned on from the Settings page, which
    // the read's next step names, so the walkthrough must not ride on every turn of a connected login.
    await store.save(record({ granted_scopes: [READ] }));
    const capability = await mount();
    expect(capability?.systemToolSets).toHaveLength(1);
    expect(capability?.instructionBuilders ?? []).toHaveLength(0);
  });

  it('mounts the walkthrough with the read when the sign-in has expired', async () => {
    await store.save(record({ status: 'needs_reconnect' }));
    const capability = await mount();
    expect(capability?.systemToolSets).toHaveLength(1);
    expect(capability?.instructionBuilders).toHaveLength(1);
  });

  it('never mounts one user the setup state of another', async () => {
    await store.save(record({ granted_scopes: [READ, COMPOSE, CALENDAR_READ, CALENDAR_WRITE] }));
    const other = await mount({ tenant_id: 't1', created_by: 'bob' });
    expect(other).toBeDefined();
    const result = await statusResult(other);
    expect(result['state']).toBe('not_connected');
  });

  it('pins the words that keep a connection alive past a week', () => {
    // A personal app left in Testing has its sign-in ended by Google after 7 days; the guidance must say
    // so, and name the fix, before the person connects.
    expect(GOOGLE_SETUP_INSTRUCTION).toContain('after 7 days');
    expect(GOOGLE_SETUP_INSTRUCTION).toContain('Publish app');
    expect(GOOGLE_SETUP_INSTRUCTION).toContain('has not verified this app');
  });

  it('pins that secrets live only in the Settings form, never in chat', () => {
    expect(GOOGLE_SETUP_INSTRUCTION).toContain('go only into the form in Settings');
    expect(GOOGLE_SETUP_INSTRUCTION).toContain('Never ask for the secret or the file in this chat');
    expect(GOOGLE_SETUP_INSTRUCTION).toContain('until the check finds no problems');
  });

  it('writes no em dashes in the guidance or the next steps', async () => {
    expect(GOOGLE_SETUP_INSTRUCTION).not.toContain('\u2014');
    const result = await statusResult(await mount());
    const next = result['next_step'];
    expect(typeof next === 'string' && !next.includes('\u2014')).toBe(true);
  });
});

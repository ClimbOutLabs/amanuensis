import type { CallToolResponse } from '@truefoundry/trueforge-core/core';
import type { GoogleConnectionRecord } from '@truefoundry/trueforge-core/core/google/connection';
import { NOOP_AGENT_TRACING } from '@truefoundry/trueforge-core/core/tracing/NoopAgentTracing';
import type { GlobalSettingRecord, IGlobalSettingsStore } from '../../../src/db/globalSettingsStore';
import { SqliteGoogleConnectionStore } from '../../../src/db/sqlite/google-connection-store/SqliteGoogleConnectionStore';
import {
  EMAIL_OFFER_DECLINE_LINE,
  EMAIL_OFFER_DECLINED_SETTING_KEY,
  EMAIL_OFFER_INSTRUCTION,
  emailOfferCapability,
  readEmailConnectionState,
  type EmailOfferDeps,
} from '../../../src/runtime/emailOfferCapability';
import { createSqliteTestDatabase, type SqliteTestDatabase } from '../../db/sqlite/testDatabase';
import { isRecord } from '../../fixtures/jsonGuards';

const OWNER = { tenant_id: 't1', created_by: 'ada' };
const READ = 'https://www.googleapis.com/auth/gmail.readonly';
const CALENDAR_READ = 'https://www.googleapis.com/auth/calendar.events.readonly';

class FakeSettingsStore implements Pick<IGlobalSettingsStore, 'getSetting' | 'setSetting'> {
  readonly values = new Map<string, string>();

  async getSetting(input: { key: string }): Promise<GlobalSettingRecord | undefined> {
    const value = this.values.get(input.key);
    return value === undefined ? undefined : { key: input.key, value, updated_at: '2026-11-07T00:00:00.000Z' };
  }

  async setSetting(input: { key: string; value: string }): Promise<GlobalSettingRecord> {
    this.values.set(input.key, input.value);
    return { key: input.key, value: input.value, updated_at: '2026-11-07T00:00:00.000Z' };
  }
}

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
    created_at: '2026-11-07T00:00:00.000Z',
    updated_at: '2026-11-07T00:00:00.000Z',
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

function parsedObject(text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) {
    throw new Error('expected a JSON object');
  }
  return parsed;
}

describe('emailOfferCapability', () => {
  let env: SqliteTestDatabase;
  let googleConnections: SqliteGoogleConnectionStore;
  let settings: FakeSettingsStore;
  let mailConnectorRegistered: boolean;

  beforeEach(async () => {
    env = await createSqliteTestDatabase();
    googleConnections = new SqliteGoogleConnectionStore(env.db);
    settings = new FakeSettingsStore();
    mailConnectorRegistered = false;
  }, 120_000);

  afterEach(async () => {
    await env.teardown();
  });

  function deps(): EmailOfferDeps {
    return {
      mailConnectorRegistered: () => Promise.resolve(mailConnectorRegistered),
      googleConnections,
      owner: OWNER,
      settings,
      tracing: NOOP_AGENT_TRACING,
    };
  }

  async function mountedSet() {
    const capability = await emailOfferCapability(deps());
    const set = capability?.systemToolSets?.[0];
    if (set === undefined) {
      throw new Error('expected the Email offer tool set to be mounted');
    }
    return { capability, set };
  }

  async function call(
    set: Awaited<ReturnType<typeof mountedSet>>['set'],
    name: string,
  ): Promise<Record<string, unknown>> {
    return parsedObject(textOf(await set.callTool({ name, arguments: {} })));
  }

  it('mounts the status and decline tools with one instruction when email is not connected', async () => {
    const { capability, set } = await mountedSet();
    expect(capability?.instructionBuilders).toHaveLength(1);
    expect(set.name).toBe('email_offer');
    const listed = await set.listTools();
    const names = 'result' in listed ? listed.result.tools.map(tool => tool.name) : [];
    expect(names).toEqual(['email_connection_status', 'record_email_offer_decline']);
  });

  it('reads as not connected before any email route is saved', async () => {
    const { set } = await mountedSet();
    const result = await call(set, 'email_connection_status');
    expect(result).toMatchObject({ connected: false, via: null, declined: false });
    const next = result['next_step'];
    expect(typeof next === 'string' && next.includes('Offer the connection on the question card')).toBe(true);
  });

  it('records a decline once, returns the one Settings line, and never mounts the offer again', async () => {
    const { set } = await mountedSet();
    const result = await call(set, 'record_email_offer_decline');
    expect(result).toEqual({ recorded: true, reply_line: EMAIL_OFFER_DECLINE_LINE });
    expect(EMAIL_OFFER_DECLINE_LINE).toBe(
      'No problem. You can connect it any time in Settings, then Connectors, from the Email card.',
    );
    expect(settings.values.get(EMAIL_OFFER_DECLINED_SETTING_KEY)).toBe('true');

    const after = await call(set, 'email_connection_status');
    expect(after).toMatchObject({ connected: false, via: null, declined: true });
    expect(await emailOfferCapability(deps())).toBeUndefined();
  });

  it('does not mount when a decline is already remembered', async () => {
    settings.values.set(EMAIL_OFFER_DECLINED_SETTING_KEY, 'true');
    expect(await readEmailConnectionState(deps())).toEqual({ connected: false, via: null, declined: true });
    expect(await emailOfferCapability(deps())).toBeUndefined();
  });

  it('treats a saved mail account as connected, so the offer does not mount', async () => {
    mailConnectorRegistered = true;
    expect(await readEmailConnectionState(deps())).toEqual({
      connected: true,
      via: 'email_account',
      declined: false,
    });
    expect(await emailOfferCapability(deps())).toBeUndefined();
  });

  it('treats a Google login that can read Gmail as connected', async () => {
    await googleConnections.save(record());
    expect(await readEmailConnectionState(deps())).toEqual({ connected: true, via: 'google', declined: false });
    expect(await emailOfferCapability(deps())).toBeUndefined();
  });

  it('does not treat a calendar-only Google login as email', async () => {
    await googleConnections.save(record({ granted_scopes: [CALENDAR_READ] }));
    expect(await readEmailConnectionState(deps())).toEqual({ connected: false, via: null, declined: false });
    expect(await emailOfferCapability(deps())).toBeDefined();
  });

  it('does not treat a Google login that needs reconnecting as connected', async () => {
    await googleConnections.save(record({ status: 'needs_reconnect' }));
    expect(await readEmailConnectionState(deps())).toEqual({ connected: false, via: null, declined: false });
    expect(await emailOfferCapability(deps())).toBeDefined();
  });

  it('tells the model to offer on the question card, route a yes to Settings, and resume the task', () => {
    expect(EMAIL_OFFER_INSTRUCTION).toContain('ask_user_question');
    expect(EMAIL_OFFER_INSTRUCTION).toContain('"Would you like to connect your email so I can do that?"');
    expect(EMAIL_OFFER_INSTRUCTION).toContain('"Connect my email"');
    expect(EMAIL_OFFER_INSTRUCTION).toContain('"Not now"');
    expect(EMAIL_OFFER_INSTRUCTION).toContain('open Settings, then Connectors');
    expect(EMAIL_OFFER_INSTRUCTION).toContain('without making them ask again');
  });

  it('keeps credentials out of chat in the offer wording', () => {
    expect(EMAIL_OFFER_INSTRUCTION).toContain('never ask for one in this chat');
    expect(EMAIL_OFFER_INSTRUCTION).toContain('never use one pasted here');
    expect(EMAIL_OFFER_INSTRUCTION).toContain('The Settings forms are the only place an app password ever goes');
  });
});

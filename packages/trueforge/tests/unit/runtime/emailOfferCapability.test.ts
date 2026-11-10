import type { AgentCapability, CallToolResponse, ContextMessage } from '@truefoundry/trueforge-core/core';
import { createToolResponseV2, newEventId } from '@truefoundry/trueforge-core/core';
import type { GoogleConnectionRecord } from '@truefoundry/trueforge-core/core/google/connection';
import { NOOP_AGENT_TRACING } from '@truefoundry/trueforge-core/core/tracing/NoopAgentTracing';
import type { GlobalSettingRecord, IGlobalSettingsStore } from '../../../src/db/globalSettingsStore';
import { SqliteGoogleConnectionStore } from '../../../src/db/sqlite/google-connection-store/SqliteGoogleConnectionStore';
import {
  EMAIL_OFFER_CONNECT_OPTION,
  EMAIL_OFFER_DECLINE_LINE,
  EMAIL_OFFER_DECLINE_OPTION,
  EMAIL_OFFER_DECLINED_SETTING_KEY,
  EMAIL_OFFER_INSTRUCTION,
  EMAIL_OFFER_QUESTION,
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

const OFFER_CALL_ID = 'call-offer';

/** The assistant message that asked one question card, as the recorded context holds it. */
function questionCardMessage(input: { question: string; options: string[] }): ContextMessage {
  return {
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: OFFER_CALL_ID,
        type: 'function',
        function: {
          name: 'ask_user_question',
          arguments: JSON.stringify({ question: input.question, options: input.options }),
        },
        tool_info: {
          type: 'truefoundry-system',
          mcp_server_id: 'ask-user-question',
          mcp_server_name: 'ask-user-question',
          original_tool_name: 'ask_user_question',
          is_approval_required: false,
          is_client_side: true,
        },
      },
    ],
  };
}

/** The tool result the host records for a card answer, built by the host's own constructor. */
function cardAnswerMessage(answer: string): ContextMessage {
  return createToolResponseV2({
    id: newEventId(),
    thread_id: 'main',
    tool_call_id: OFFER_CALL_ID,
    created_at: '2026-11-07T00:01:00.000Z',
    raw_content: answer,
    model_content: null,
    screen: null,
    disposition: 'executed_ok',
    remediation: undefined,
    admission_provenance: { source: 'internal' },
    memoized: false,
    repeat_count: 1,
  }).model_message;
}

function offerCardContext(answer: string): ContextMessage[] {
  return [
    { role: 'user', content: 'Can you read my latest mail?' },
    questionCardMessage({
      question: EMAIL_OFFER_QUESTION,
      options: [EMAIL_OFFER_CONNECT_OPTION, EMAIL_OFFER_DECLINE_OPTION],
    }),
    cardAnswerMessage(answer),
  ];
}

/** Runs the capability's own pre-model pass over a recorded context, as the thread does before every model call. */
async function runPreModelPass(capability: AgentCapability, context: ContextMessage[]): Promise<void> {
  const processors = capability.preLLMProcessors ?? [];
  expect(processors).toHaveLength(1);
  for (const processor of processors) {
    const outputs: unknown[] = [];
    for await (const output of processor.processPreLLM({
      threadId: 'main',
      currentContextUsage: { prompt_tokens: 0, completion_tokens: 0 },
      context,
    })) {
      outputs.push(output);
    }
    expect(outputs).toEqual([]);
  }
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
    if (capability === undefined || set === undefined) {
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

  it('records a decline that follows the offer card’s own decline answer, and never mounts the offer again', async () => {
    const { capability, set } = await mountedSet();
    await runPreModelPass(capability, offerCardContext(EMAIL_OFFER_DECLINE_OPTION));
    const result = await call(set, 'record_email_offer_decline');
    expect(result).toMatchObject({ recorded: true, reply_line: EMAIL_OFFER_DECLINE_LINE });
    expect(String(result['next_step'])).toContain('The no was remembered.');
    expect(EMAIL_OFFER_DECLINE_LINE).toBe(
      'No problem. You can connect it any time in Settings, then Connectors, from the Email card.',
    );
    expect(settings.values.get(EMAIL_OFFER_DECLINED_SETTING_KEY)).toBe('true');

    const after = await call(set, 'email_connection_status');
    expect(after).toMatchObject({ connected: false, via: null, declined: true });
    expect(await emailOfferCapability(deps())).toBeUndefined();
  });

  it('records nothing when a decline is called with no card answer behind it', async () => {
    const { capability, set } = await mountedSet();
    await runPreModelPass(capability, [
      { role: 'user', content: 'Can you read my latest mail?' },
      { role: 'assistant', content: 'I would need email connected for that. Shall I offer it?' },
      { role: 'user', content: 'No thanks.' },
    ]);
    const result = await call(set, 'record_email_offer_decline');
    expect(result).toMatchObject({ recorded: false, reply_line: EMAIL_OFFER_DECLINE_LINE });
    expect(String(result['next_step'])).toContain('The no was not remembered');
    expect(settings.values.has(EMAIL_OFFER_DECLINED_SETTING_KEY)).toBe(false);

    const after = await call(set, 'email_connection_status');
    expect(after).toMatchObject({ connected: false, via: null, declined: false });
  });

  it('records nothing when the decline follows the card’s connect answer', async () => {
    const { capability, set } = await mountedSet();
    await runPreModelPass(capability, offerCardContext(EMAIL_OFFER_CONNECT_OPTION));
    const result = await call(set, 'record_email_offer_decline');
    expect(result).toMatchObject({ recorded: false, reply_line: EMAIL_OFFER_DECLINE_LINE });
    expect(settings.values.has(EMAIL_OFFER_DECLINED_SETTING_KEY)).toBe(false);
  });

  it('records nothing for a free-text answer typed on the card instead of its decline choice', async () => {
    const { capability, set } = await mountedSet();
    await runPreModelPass(capability, offerCardContext('No way, not ever'));
    const result = await call(set, 'record_email_offer_decline');
    expect(result).toMatchObject({ recorded: false });
    expect(settings.values.has(EMAIL_OFFER_DECLINED_SETTING_KEY)).toBe(false);
  });

  it('records nothing for the decline choice on some other question card', async () => {
    const { capability, set } = await mountedSet();
    await runPreModelPass(capability, [
      { role: 'user', content: 'Can you read my latest mail?' },
      questionCardMessage({
        question: 'Shall I hook up your email for you?',
        options: [EMAIL_OFFER_CONNECT_OPTION, EMAIL_OFFER_DECLINE_OPTION],
      }),
      cardAnswerMessage(EMAIL_OFFER_DECLINE_OPTION),
    ]);
    const result = await call(set, 'record_email_offer_decline');
    expect(result).toMatchObject({ recorded: false });
    expect(settings.values.has(EMAIL_OFFER_DECLINED_SETTING_KEY)).toBe(false);
  });

  it('records nothing when the card answer is no longer the exchange this turn continues from', async () => {
    const { capability, set } = await mountedSet();
    await runPreModelPass(capability, [
      ...offerCardContext(EMAIL_OFFER_DECLINE_OPTION),
      { role: 'assistant', content: 'Understood, we can work from what you paste instead.' },
      { role: 'user', content: 'Actually, let us try something else.' },
    ]);
    const result = await call(set, 'record_email_offer_decline');
    expect(result).toMatchObject({ recorded: false });
    expect(settings.values.has(EMAIL_OFFER_DECLINED_SETTING_KEY)).toBe(false);
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

  it('tells the model only a card answer is remembered, and a typed no is never claimed as remembered', () => {
    expect(EMAIL_OFFER_INSTRUCTION).toContain('Only a no picked on the card is remembered');
    expect(EMAIL_OFFER_INSTRUCTION).toContain('A no in their own words is not remembered');
    expect(EMAIL_OFFER_INSTRUCTION).toContain('never say it was remembered');
  });

  it('keeps credentials out of chat in the offer wording', () => {
    expect(EMAIL_OFFER_INSTRUCTION).toContain('never ask for one in this chat');
    expect(EMAIL_OFFER_INSTRUCTION).toContain('never use one pasted here');
    expect(EMAIL_OFFER_INSTRUCTION).toContain('The Settings forms are the only place an app password ever goes');
  });
});

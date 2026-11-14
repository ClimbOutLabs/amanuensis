import type { AgentCapability, CallToolResponse, ContextMessage } from '@truefoundry/trueforge-core/core';
import { createToolResponseV2, newEventId } from '@truefoundry/trueforge-core/core';
import type { GoogleConnectionRecord } from '@truefoundry/trueforge-core/core/google/connection';
import { NOOP_AGENT_TRACING } from '@truefoundry/trueforge-core/core/tracing/NoopAgentTracing';
import type { GlobalSettingRecord, IGlobalSettingsStore } from '../../../src/db/globalSettingsStore';
import { SqliteGoogleConnectionStore } from '../../../src/db/sqlite/google-connection-store/SqliteGoogleConnectionStore';
import {
  connectionOfferCapability,
  connectionOfferInstruction,
  readConnectionOfferState,
  type ConnectionOfferDeps,
} from '../../../src/runtime/connectionOfferCapability';
import {
  CONNECTION_OFFER_DECLINED_SETTING_KEYS,
  connectionOfferDeclinedSettingKey,
  OFFERABLE_CONNECTORS,
  type OfferableConnector,
} from '../../../src/runtime/connectionOfferRegistry';
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

const [EMAIL] = OFFERABLE_CONNECTORS;

/** A second, made-up entry: proof that the offer is built from the registry it is given, not from email. */
let calendarConnected: boolean;
const FAKE_CALENDAR: OfferableConnector = {
  id: 'calendar',
  name: 'calendar',
  neededFor: 'reading or adding events',
  question: 'Would you like to connect your calendar so I can do that?',
  connectOption: 'Connect my calendar',
  declineOption: 'Maybe later',
  settingsCard: 'the Calendar card',
  replyLine: 'No problem. You can connect it any time in Settings, then Connectors, from the Calendar card.',
  connectedVia: () => Promise.resolve(calendarConnected ? 'calendar_account' : null),
};

function offerCardContext(input: { answer: string; connector?: OfferableConnector }): ContextMessage[] {
  const connector = input.connector ?? EMAIL;
  return [
    { role: 'user', content: 'Can you read my latest mail?' },
    questionCardMessage({
      question: connector.question,
      options: [connector.connectOption, connector.declineOption],
    }),
    cardAnswerMessage(input.answer),
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

describe('connectionOfferCapability', () => {
  let env: SqliteTestDatabase;
  let googleConnections: SqliteGoogleConnectionStore;
  let settings: FakeSettingsStore;
  let mailConnectorRegistered: boolean;

  beforeEach(async () => {
    env = await createSqliteTestDatabase();
    googleConnections = new SqliteGoogleConnectionStore(env.db);
    settings = new FakeSettingsStore();
    mailConnectorRegistered = false;
    calendarConnected = false;
  }, 120_000);

  afterEach(async () => {
    await env.teardown();
  });

  function deps(connectors: ConnectionOfferDeps['connectors'] = OFFERABLE_CONNECTORS): ConnectionOfferDeps {
    return {
      connectors,
      host: {
        mailConnectorRegistered: () => Promise.resolve(mailConnectorRegistered),
        googleConnections,
        owner: OWNER,
      },
      settings,
      tracing: NOOP_AGENT_TRACING,
    };
  }

  function twoConnectorDeps(): ConnectionOfferDeps {
    return deps([EMAIL, FAKE_CALENDAR]);
  }

  async function mountedSet(offerDeps: ConnectionOfferDeps = deps()) {
    const capability = await connectionOfferCapability(offerDeps);
    const set = capability?.systemToolSets?.[0];
    if (capability === undefined || set === undefined) {
      throw new Error('expected the connection offer tool set to be mounted');
    }
    return { capability, set };
  }

  async function call(
    set: Awaited<ReturnType<typeof mountedSet>>['set'],
    input: { name: string; connector?: string },
  ): Promise<Record<string, unknown>> {
    return parsedObject(
      textOf(await set.callTool({ name: input.name, arguments: { connector: input.connector ?? 'email' } })),
    );
  }

  function emailState() {
    return readConnectionOfferState({ connector: EMAIL, deps: deps() });
  }

  it('has email as its first registry entry, with the card words the person sees', () => {
    expect(EMAIL).toMatchObject({
      id: 'email',
      question: 'Would you like to connect your email so I can do that?',
      connectOption: 'Connect my email',
      declineOption: 'Not now',
      replyLine: 'No problem. You can connect it any time in Settings, then Connectors, from the Email card.',
    });
    expect(CONNECTION_OFFER_DECLINED_SETTING_KEYS).toEqual(['connection_offer_declined_email']);
  });

  it('mounts the status and decline tools with one instruction when email is not connected', async () => {
    const { capability, set } = await mountedSet();
    expect(capability.instructionBuilders).toHaveLength(1);
    expect(set.name).toBe('connection_offer');
    const listed = await set.listTools();
    const names = 'result' in listed ? listed.result.tools.map(tool => tool.name) : [];
    expect(names).toEqual(['connection_offer_status', 'record_connection_offer_decline']);
  });

  it('reads as not connected before any email route is saved', async () => {
    const { set } = await mountedSet();
    const result = await call(set, { name: 'connection_offer_status' });
    expect(result).toMatchObject({
      connector: 'email',
      connected: false,
      via: null,
      declined: false,
      offered_in_this_chat: false,
    });
    expect(String(result['next_step'])).toContain('Offer the connection on its question card');
  });

  it('refuses a connector the registry does not hold, and says what to call instead', async () => {
    const { set } = await mountedSet();
    const response = await set.callTool({ name: 'record_connection_offer_decline', arguments: { connector: 'fax' } });
    expect('result' in response && response.result.isError).toBe(true);
    expect(textOf(response)).toBe('That connector cannot be offered here. Call again with one of: email.');
    expect(settings.values.size).toBe(0);
  });

  it('records a decline that follows the offer card’s own decline answer, and never mounts the offer again', async () => {
    const { capability, set } = await mountedSet();
    await runPreModelPass(capability, offerCardContext({ answer: EMAIL.declineOption }));
    const result = await call(set, { name: 'record_connection_offer_decline' });
    expect(result).toMatchObject({ connector: 'email', recorded: true, reply_line: EMAIL.replyLine });
    expect(String(result['next_step'])).toContain('The no was remembered.');
    expect(settings.values.get(connectionOfferDeclinedSettingKey('email'))).toBe('true');

    const after = await call(set, { name: 'connection_offer_status' });
    expect(after).toMatchObject({ connected: false, via: null, declined: true });
    expect(await connectionOfferCapability(deps())).toBeUndefined();
  });

  it('records nothing when a decline is called with no card answer behind it', async () => {
    const { capability, set } = await mountedSet();
    await runPreModelPass(capability, [
      { role: 'user', content: 'Can you read my latest mail?' },
      { role: 'assistant', content: 'I would need email connected for that. Shall I offer it?' },
      { role: 'user', content: 'No thanks.' },
    ]);
    const result = await call(set, { name: 'record_connection_offer_decline' });
    expect(result).toMatchObject({ recorded: false, reply_line: EMAIL.replyLine });
    expect(String(result['next_step'])).toContain('The no was not remembered');
    expect(settings.values.size).toBe(0);

    const after = await call(set, { name: 'connection_offer_status' });
    expect(after).toMatchObject({ connected: false, via: null, declined: false, offered_in_this_chat: false });
  });

  it('records nothing when the decline follows the card’s connect answer', async () => {
    const { capability, set } = await mountedSet();
    await runPreModelPass(capability, offerCardContext({ answer: EMAIL.connectOption }));
    const result = await call(set, { name: 'record_connection_offer_decline' });
    expect(result).toMatchObject({ recorded: false, reply_line: EMAIL.replyLine });
    expect(settings.values.size).toBe(0);
  });

  it('records nothing for a free-text answer typed on the card instead of its decline choice', async () => {
    const { capability, set } = await mountedSet();
    await runPreModelPass(capability, offerCardContext({ answer: 'No way, not ever' }));
    const result = await call(set, { name: 'record_connection_offer_decline' });
    expect(result).toMatchObject({ recorded: false });
    expect(settings.values.size).toBe(0);
  });

  it('records nothing for the decline choice on some other question card', async () => {
    const { capability, set } = await mountedSet();
    await runPreModelPass(capability, [
      { role: 'user', content: 'Can you read my latest mail?' },
      questionCardMessage({
        question: 'Shall I hook up your email for you?',
        options: [EMAIL.connectOption, EMAIL.declineOption],
      }),
      cardAnswerMessage(EMAIL.declineOption),
    ]);
    const result = await call(set, { name: 'record_connection_offer_decline' });
    expect(result).toMatchObject({ recorded: false });
    expect(settings.values.size).toBe(0);
  });

  it('records nothing when the card answer is no longer the exchange this turn continues from', async () => {
    const { capability, set } = await mountedSet();
    await runPreModelPass(capability, [
      ...offerCardContext({ answer: EMAIL.declineOption }),
      { role: 'assistant', content: 'Understood, we can work from what you paste instead.' },
      { role: 'user', content: 'Actually, let us try something else.' },
    ]);
    const result = await call(set, { name: 'record_connection_offer_decline' });
    expect(result).toMatchObject({ recorded: false });
    expect(settings.values.size).toBe(0);
  });

  it('says from the recorded chat when its card was already shown, so the model is told not to show it again', async () => {
    const { capability, set } = await mountedSet();
    await runPreModelPass(capability, [
      ...offerCardContext({ answer: 'No, I would rather not' }),
      { role: 'assistant', content: 'No problem.' },
      { role: 'user', content: 'Then can you check my mail for the invoice?' },
    ]);
    const result = await call(set, { name: 'connection_offer_status' });
    expect(result).toMatchObject({ connected: false, declined: false, offered_in_this_chat: true });
    expect(String(result['next_step'])).toContain('Do not show it again');
  });

  it('does not mount when a decline is already remembered', async () => {
    settings.values.set(connectionOfferDeclinedSettingKey('email'), 'true');
    expect(await emailState()).toEqual({ connected: false, via: null, declined: true });
    expect(await connectionOfferCapability(deps())).toBeUndefined();
  });

  it('treats a saved mail account as connected, so the offer does not mount', async () => {
    mailConnectorRegistered = true;
    expect(await emailState()).toEqual({ connected: true, via: 'email_account', declined: false });
    expect(await connectionOfferCapability(deps())).toBeUndefined();
  });

  it('treats a Google login that can read Gmail as connected', async () => {
    await googleConnections.save(record());
    expect(await emailState()).toEqual({ connected: true, via: 'google', declined: false });
    expect(await connectionOfferCapability(deps())).toBeUndefined();
  });

  it('does not treat a calendar-only Google login as email', async () => {
    await googleConnections.save(record({ granted_scopes: [CALENDAR_READ] }));
    expect(await emailState()).toEqual({ connected: false, via: null, declined: false });
    expect(await connectionOfferCapability(deps())).toBeDefined();
  });

  it('does not treat a Google login that needs reconnecting as connected', async () => {
    await googleConnections.save(record({ status: 'needs_reconnect' }));
    expect(await emailState()).toEqual({ connected: false, via: null, declined: false });
    expect(await connectionOfferCapability(deps())).toBeDefined();
  });

  describe('with a second registry entry', () => {
    it('offers every entry that is neither connected nor declined, and names only those', async () => {
      const both = connectionOfferInstruction([EMAIL, FAKE_CALENDAR]);
      expect(both).toContain(`"${FAKE_CALENDAR.question}"`);
      expect(both).toContain(`"${EMAIL.question}"`);

      mailConnectorRegistered = true;
      const { set } = await mountedSet(twoConnectorDeps());
      expect(await call(set, { name: 'connection_offer_status', connector: 'calendar' })).toMatchObject({
        connector: 'calendar',
        connected: false,
      });
      expect(await call(set, { name: 'connection_offer_status', connector: 'email' })).toMatchObject({
        connector: 'email',
        connected: true,
        via: 'email_account',
      });
    });

    it('remembers a no only for the connector whose own card was answered', async () => {
      const { capability, set } = await mountedSet(twoConnectorDeps());
      await runPreModelPass(
        capability,
        offerCardContext({ answer: FAKE_CALENDAR.declineOption, connector: FAKE_CALENDAR }),
      );
      expect(await call(set, { name: 'record_connection_offer_decline', connector: 'email' })).toMatchObject({
        connector: 'email',
        recorded: false,
      });
      expect(await call(set, { name: 'record_connection_offer_decline', connector: 'calendar' })).toMatchObject({
        connector: 'calendar',
        recorded: true,
        reply_line: FAKE_CALENDAR.replyLine,
      });
      expect([...settings.values.keys()]).toEqual([connectionOfferDeclinedSettingKey('calendar')]);
      // Email is still offered on its own; the remembered no for calendar does not touch it.
      expect(await connectionOfferCapability(twoConnectorDeps())).toBeDefined();
    });

    it('does not take one connector’s decline option on another connector’s card', async () => {
      const { capability, set } = await mountedSet(twoConnectorDeps());
      await runPreModelPass(capability, offerCardContext({ answer: FAKE_CALENDAR.declineOption }));
      expect(await call(set, { name: 'record_connection_offer_decline', connector: 'email' })).toMatchObject({
        recorded: false,
      });
      expect(settings.values.size).toBe(0);
    });

    it('mounts nothing once every entry is connected or declined', async () => {
      mailConnectorRegistered = true;
      settings.values.set(connectionOfferDeclinedSettingKey('calendar'), 'true');
      expect(await connectionOfferCapability(twoConnectorDeps())).toBeUndefined();
      calendarConnected = true;
      settings.values.clear();
      expect(await connectionOfferCapability(twoConnectorDeps())).toBeUndefined();
    });
  });

  describe('the instruction', () => {
    const instruction = connectionOfferInstruction([EMAIL]);

    it('tells the model to offer on the question card, route a yes to Settings, and resume the task', () => {
      expect(instruction).toContain('ask_user_question');
      expect(instruction).toContain('"Would you like to connect your email so I can do that?"');
      expect(instruction).toContain('"Connect my email"');
      expect(instruction).toContain('"Not now"');
      expect(instruction).toContain('open Settings, then Connectors');
      expect(instruction).toContain('from the Email card.');
      expect(instruction).not.toContain('Google');
      expect(instruction).toContain('without making them ask again');
    });

    it('tells the model only a card answer is remembered, and a typed no is never claimed as remembered', () => {
      expect(instruction).toContain('Only a no picked on the card is remembered');
      expect(instruction).toContain('A no in their own words is not remembered');
      expect(instruction).toContain('never say it was remembered');
    });

    it('keeps credentials out of chat in the offer wording', () => {
      expect(instruction).toContain('never ask for one in this chat');
      expect(instruction).toContain('never use one pasted here');
      expect(instruction).toContain('The Settings forms are the only place a password ever goes');
    });

    it('is no longer than the email-only instruction it replaced', () => {
      // The email-only instruction it replaced was 1,617 characters (about 404 tokens).
      expect(instruction.length).toBeLessThanOrEqual(1617);
    });
  });
});

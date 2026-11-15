/**
 * Which day a chat is told it is, through the real server. A browser says the person's time zone with each
 * message. Telegram sends only the moment a message was written, so the zone has to come from what Aman knows.
 */
import { z } from '@hono/zod-openapi';
import { STANDALONE_REQUEST_CONTEXT } from '../../../src/auth/identity';
import configuration from '../../../src/config';
import { TelegramStore } from '../../../src/db/telegramStore';
import { GetTurnResponseSchema, ListTurnsResponseSchema } from '../../../src/schemas/turn';
import { MODEL_FQN, startApprovalTestServer, type ApprovalTestServer } from '../../fixtures/approvalTestServer';

const TURN_TIMEOUT_MS = 60_000;
const TENANT = 'default';
const OWNER = STANDALONE_REQUEST_CONTEXT.subject.id;
const TELEGRAM_USER_ID = 4242;

const AGENT_SPEC = {
  model: { name: MODEL_FQN },
  instructions: 'Answer the user.',
  config: {
    sandbox: { enabled: false },
    generative_ui: { enabled: false },
    ask_user_questions: { enabled: false },
    dynamic_sub_agents: { enabled: false },
    context_management: { compaction: { enabled: false }, large_tool_response: { enabled: false } },
  },
};

function json(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

describe('the day a chat is told it is', () => {
  let server: ApprovalTestServer;
  let nextUpdateId = 1;

  beforeAll(async () => {
    server = await startApprovalTestServer();
    const store = new TelegramStore(server.db());
    await store.saveConnection({
      tenant_id: TENANT,
      created_by: OWNER,
      created_by_subject: {
        subject_id: OWNER,
        subject_type: 'user',
        subject_display_name: STANDALONE_REQUEST_CONTEXT.subject.display_name,
      },
      bot_token: '123456:test-token',
      bot_id: '123456',
      bot_name: 'Test bot',
      bot_username: 'test_bot',
      transport: 'polling',
      webhook_secret: null,
    });
    await store.startPairing({
      tenant_id: TENANT,
      created_by: OWNER,
      code: '123456',
      expires_at: new Date(Date.now() + 60_000),
      telegram_user_id: String(TELEGRAM_USER_ID),
      chat_id: String(TELEGRAM_USER_ID),
      display_name: 'Sam',
    });
    expect(await store.confirmPairing({ tenant_id: TENANT, created_by: OWNER, code: '123456' })).toBe(true);
  }, 120_000);

  afterAll(async () => {
    await server.close();
  }, TURN_TIMEOUT_MS);

  /** The date line of the newest reply the model was asked for. */
  function dateLineShownToModel(): string {
    const lines = server.model
      .requests()
      .map(request => /<current-date>(.*?)<\/current-date>/s.exec(JSON.stringify(request))?.[1])
      .filter(line => line !== undefined);
    const newest = lines[lines.length - 1];
    if (newest === undefined) {
      throw new Error('The model was asked for no reply.');
    }
    return newest;
  }

  async function sendFromBrowser(timeZone: string): Promise<string> {
    const created = await server.request('/api/v1/sessions', json({ agent: { spec: AGENT_SPEC } }));
    const chatId = z.object({ data: z.object({ id: z.string() }).loose() }).parse(await created.json()).data.id;
    const turn = await server.request(
      `/api/v1/sessions/${chatId}/turns`,
      json({
        input: [{ type: 'user.message', content: 'What day is it?' }],
        stream: true,
        client_timezone: timeZone,
      }),
    );
    expect(turn.status).toBe(200);
    await turn.text();
    return dateLineShownToModel();
  }

  async function sendFromTelegram(): Promise<string> {
    const store = new TelegramStore(server.db());
    const connection = await store.getConnection({ tenant_id: TENANT, created_by: OWNER });
    if (connection === undefined) {
      throw new Error('The test bot is not connected.');
    }
    const asked = server.model.requests().length;
    const response = await server.request('/api/internal/telegram/updates', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${configuration.TRUEFORGE_API_KEY}` },
      body: JSON.stringify({
        connection_id: connection.id,
        update: {
          update_id: nextUpdateId++,
          message: {
            message_id: nextUpdateId,
            from: { id: TELEGRAM_USER_ID, is_bot: false, first_name: 'Sam' },
            chat: { id: TELEGRAM_USER_ID, type: 'private' },
            // All Telegram gives: the moment, the same number everywhere in the world.
            date: Math.floor(Date.now() / 1000),
            text: 'What day is it?',
          },
        },
      }),
    });
    expect(response.status).toBe(204);
    const sessionId = (await store.getConnection({ tenant_id: TENANT, created_by: OWNER }))?.session_id ?? null;
    if (sessionId === null) {
      throw new Error('The Telegram message started no chat.');
    }
    const deadline = Date.now() + TURN_TIMEOUT_MS;
    for (;;) {
      const list = ListTurnsResponseSchema.parse(
        await (await server.request(`/api/v1/sessions/${sessionId}/turns`)).json(),
      );
      const turnId = list.data[0]?.id;
      const turn =
        turnId === undefined
          ? undefined
          : GetTurnResponseSchema.parse(
              await (await server.request(`/api/v1/sessions/${sessionId}/turns/${turnId}`)).json(),
            ).data;
      if (turn !== undefined && turn.state.status !== 'running' && server.model.requests().length > asked) {
        return dateLineShownToModel();
      }
      if (Date.now() > deadline) {
        throw new Error('The Telegram turn did not finish in time.');
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }

  async function reachMe() {
    const body = z
      .object({
        data: z
          .object({
            saved: z.boolean(),
            settings: z.object({ timezone: z.string(), noticing_on: z.boolean() }).loose(),
          })
          .loose(),
      })
      .parse(await (await server.request('/api/v1/user/reach')).json());
    return {
      saved: body.data.saved,
      timezone: body.data.settings.timezone,
      noticing_on: body.data.settings.noticing_on,
    };
  }

  it(
    'gives each message one day, the person’s own, whichever way the message came in',
    async () => {
      // Nothing says where this person is yet. The chat gets the UTC day and is told it may not be theirs.
      const unknown = await sendFromTelegram();
      expect(unknown).toMatch(
        /Today's date is \d{4}-\d{2}-\d{2} \(\w+, UTC, because the person's time zone is not known\)\./,
      );

      // A browser message: one date, in the browser's zone, and no second date in UTC beside it.
      const auckland = await sendFromBrowser('Pacific/Auckland');
      expect(auckland).toMatch(/Today's date is \d{4}-\d{2}-\d{2} \(\w+, Pacific\/Auckland, UTC\+1[23]:00\)\./);
      expect(auckland.match(/\d{4}-\d{2}-\d{2}/g)).toHaveLength(1);
      expect(auckland).not.toContain('UTC)');

      // That zone is now kept in Reach me, as the quiet defaults, so nothing starts checking because of it.
      expect(await reachMe()).toEqual({ saved: true, timezone: 'Pacific/Auckland', noticing_on: false });

      // The next Telegram message is read in it.
      expect(await sendFromTelegram()).toContain('Pacific/Auckland');

      // A browser somewhere else counts for its own message, and the saved zone is left as it was.
      expect(await sendFromBrowser('America/Los_Angeles')).toContain('America/Los_Angeles, UTC-0');
      expect((await reachMe()).timezone).toBe('Pacific/Auckland');
    },
    TURN_TIMEOUT_MS * 3,
  );
});

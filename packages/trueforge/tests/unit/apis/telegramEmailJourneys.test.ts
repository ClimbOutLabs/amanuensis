/**
 * An email asked for in the Telegram chat, through the real server: the message to the bot, the approval
 * message the bot sends back, the tap on its button, and what the stand-in mail server then receives.
 */
import { isMailSendToolName } from '@truefoundry/trueforge-core/core/email/mailConnector/toolContract';
import { createLogger } from 'winston';
import { STANDALONE_REQUEST_CONTEXT } from '../../../src/auth/identity';
import configuration from '../../../src/config';
import { SqliteMcpServerStore } from '../../../src/db/sqlite/mcp-server-store/SqliteMcpServerStore';
import { TelegramStore } from '../../../src/db/telegramStore';
import { registerMailConnector } from '../../../src/runtime/mailConnector';
import { deliverPendingTelegramReplies } from '../../../src/runtime/telegram/telegramReplies';
import { createTelegramService } from '../../../src/runtime/telegram/telegramService';
import { GetTurnResponseSchema, ListTurnsResponseSchema } from '../../../src/schemas/turn';
import { startApprovalTestServer, type ApprovalTestServer } from '../../fixtures/approvalTestServer';
import {
  INERT_MAIL_ACCOUNTS,
  startInertMcpServer,
  type InertMailCall,
  type InertMcpServer,
} from '../../fixtures/inertMcpServer';
import { RUN_DIRECTIVE_PREFIX } from '../../fixtures/scriptedModelServer';
import { FakeTelegramClient, immediateQueue } from '../../fixtures/telegramFakes';

const TURN_TIMEOUT_MS = 60_000;
const TENANT = 'default';
const OWNER = STANDALONE_REQUEST_CONTEXT.subject.id;
const PERSON = 4242;
const SOMEONE_ELSE = 9001;
const [HOME_ACCOUNT] = INERT_MAIL_ACCOUNTS;

const serviceHeaders = {
  'content-type': 'application/json',
  authorization: `Bearer ${configuration.TRUEFORGE_API_KEY}`,
};

describe('an email the person asks for in Telegram', () => {
  let server: ApprovalTestServer;
  let mailServer: InertMcpServer;
  let bot: FakeTelegramClient;
  let nextUpdateId = 1;
  const originalMailUrl = configuration.MAIL_SIDECAR_MCP_URL;

  beforeAll(() => {
    // The server's own bot client must never reach Telegram: its calls fail at once, everything else goes through.
    const realFetch = globalThis.fetch;
    jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation((input, init) =>
        String(input instanceof Request ? input.url : input).includes('api.telegram.org')
          ? Promise.reject(new Error('No Telegram in tests.'))
          : realFetch(input, init),
      );
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  beforeEach(async () => {
    // A server of its own for each test, so each Telegram chat starts empty.
    server = await startApprovalTestServer({ mailSendList: true });
    mailServer = await startInertMcpServer({ mail: true });
    server.setFirstPartyOrigins([mailServer.origin]);
    configuration.MAIL_SIDECAR_MCP_URL = mailServer.url;
    await registerMailConnector({
      url: mailServer.url,
      mcpServerStore: new SqliteMcpServerStore(server.db()),
      tenant_id: TENANT,
    });
    bot = new FakeTelegramClient();
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
      telegram_user_id: String(PERSON),
      chat_id: String(PERSON),
      display_name: 'Sam',
    });
    expect(await store.confirmPairing({ tenant_id: TENANT, created_by: OWNER, code: '123456' })).toBe(true);
  }, 120_000);

  afterEach(async () => {
    configuration.MAIL_SIDECAR_MCP_URL = originalMailUrl;
    await mailServer.close();
    await server.close();
  });

  function sent(): InertMailCall[] {
    return mailServer.mailCalls().filter(call => isMailSendToolName(call.name));
  }

  async function chatId(): Promise<string> {
    const connection = await new TelegramStore(server.db()).getConnection({ tenant_id: TENANT, created_by: OWNER });
    const sessionId = connection?.session_id ?? null;
    if (sessionId === null) {
      throw new Error('the Telegram message started no chat');
    }
    return sessionId;
  }

  /** Hands the server one Telegram update, as the poller does. */
  async function deliverUpdate(update: object): Promise<void> {
    const connection = await new TelegramStore(server.db()).getConnection({ tenant_id: TENANT, created_by: OWNER });
    const response = await server.request('/api/internal/telegram/updates', {
      method: 'POST',
      headers: serviceHeaders,
      body: JSON.stringify({ connection_id: connection?.id, update: { update_id: nextUpdateId++, ...update } }),
    });
    expect(response.status).toBe(204);
  }

  /** Waits until this many turns of the Telegram chat exist and none is running. */
  async function turnsSettled(count: number): Promise<void> {
    const sessionId = await chatId();
    const deadline = Date.now() + TURN_TIMEOUT_MS;
    for (;;) {
      const list = ListTurnsResponseSchema.parse(
        await (await server.request(`/api/v1/sessions/${sessionId}/turns`)).json(),
      );
      const states = await Promise.all(
        list.data.map(
          async turn =>
            GetTurnResponseSchema.parse(
              await (await server.request(`/api/v1/sessions/${sessionId}/turns/${turn.id}`)).json(),
            ).data.state.status,
        ),
      );
      if (states.length >= count && states.every(status => status !== 'running')) {
        return;
      }
      if (Date.now() > deadline) {
        throw new Error(`the Telegram chat did not settle at ${String(count)} turns`);
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }

  /** The person asks the bot to send this email; returns once Aman has stopped to ask. */
  async function askInTelegram(email: { recipients: string[]; subject: string; body: string }): Promise<void> {
    server.model.next({ toolArguments: email });
    await deliverUpdate({
      message: {
        message_id: nextUpdateId,
        from: { id: PERSON, is_bot: false, first_name: 'Sam' },
        chat: { id: PERSON, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        text: `${RUN_DIRECTIVE_PREFIX}send_email to ${email.recipients.join(', ')}`,
      },
    });
    await turnsSettled(1);
  }

  /** Sends what the bot owes the Telegram chat, and returns the last message with buttons. */
  async function botMessages() {
    const store = new TelegramStore(server.db());
    await deliverPendingTelegramReplies({
      store,
      service: createTelegramService({ store, publicBaseUrl: 'http://localhost', createClient: () => bot }),
      queue: immediateQueue,
      sessionStore: server.sessionStore(),
      logger: createLogger({ silent: true }),
    });
    return bot.sent;
  }

  async function tap({ callback_data, from }: { callback_data: string; from: number }): Promise<void> {
    await deliverUpdate({
      callback_query: { id: `cb-${String(nextUpdateId)}`, from: { id: from, first_name: 'Sam' }, data: callback_data },
    });
  }

  const EMAIL = {
    recipients: ['dana.reyes@harbour.example'],
    subject: 'Bread order',
    body: 'Hi Dana, could I order two loaves for Saturday?',
  };

  async function approvalMessage() {
    const asking = (await botMessages()).find(message => message.inline_buttons !== undefined);
    if (asking === undefined) {
      throw new Error(`the bot sent no message with buttons: ${JSON.stringify(bot.sent)}`);
    }
    const [approve, deny] = asking.inline_buttons?.[0] ?? [];
    if (approve === undefined || deny === undefined) {
      throw new Error('the approval message has no Approve and Deny buttons');
    }
    return { text: asking.text, approve, deny };
  }

  it(
    'gets the whole email in the bot’s message first, and it is sent only after the person taps to approve',
    async () => {
      await askInTelegram(EMAIL);
      const message = await approvalMessage();
      for (const shown of [EMAIL.recipients[0], EMAIL.subject, EMAIL.body, HOME_ACCOUNT]) {
        expect(message.text).toContain(shown);
      }
      expect(message.approve.text).toBe('Add and send');
      expect(sent()).toEqual([]);

      await tap({ callback_data: message.approve.callback_data, from: PERSON });
      await turnsSettled(2);
      expect(sent()).toEqual([{ name: 'send_email', arguments: { ...EMAIL, account_name: HOME_ACCOUNT } }]);

      // The button is used up: a second tap sends nothing more.
      await tap({ callback_data: message.approve.callback_data, from: PERSON });
      await turnsSettled(2);
      expect(sent()).toHaveLength(1);
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'is not sent when the person taps Deny',
    async () => {
      await askInTelegram(EMAIL);
      const message = await approvalMessage();

      await tap({ callback_data: message.deny.callback_data, from: PERSON });
      await turnsSettled(2);
      expect(sent()).toEqual([]);
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'is not sent when someone other than the paired person taps the button',
    async () => {
      await askInTelegram(EMAIL);
      const message = await approvalMessage();

      await tap({ callback_data: message.approve.callback_data, from: SOMEONE_ELSE });
      await turnsSettled(1);
      expect(sent()).toEqual([]);
    },
    TURN_TIMEOUT_MS,
  );
});

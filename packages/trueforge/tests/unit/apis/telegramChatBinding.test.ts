/**
 * The Telegram chat is a plain chat, like one started here: the app lists it under the person's own
 * assistant rather than under the made-up name of an agent the host makes, and its setup can change.
 */
import { STANDALONE_REQUEST_CONTEXT } from '../../../src/auth/identity';
import configuration from '../../../src/config';
import { TelegramStore } from '../../../src/db/telegramStore';
import { startApprovalTestServer, type ApprovalTestServer } from '../../fixtures/approvalTestServer';

const TIMEOUT_MS = 60_000;
const TENANT = 'default';
const OWNER = STANDALONE_REQUEST_CONTEXT.subject.id;
const OWNER_SUBJECT = {
  subject_id: OWNER,
  subject_type: 'user' as const,
  subject_display_name: STANDALONE_REQUEST_CONTEXT.subject.display_name,
};
const TELEGRAM_USER_ID = 4242;

describe('the Telegram chat', () => {
  let server: ApprovalTestServer;

  beforeAll(async () => {
    server = await startApprovalTestServer();
    const store = new TelegramStore(server.db());
    await store.saveConnection({
      tenant_id: TENANT,
      created_by: OWNER,
      created_by_subject: OWNER_SUBJECT,
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
  }, TIMEOUT_MS);

  afterAll(async () => {
    await server.close();
  }, TIMEOUT_MS);

  it(
    'is a plain chat on the default model, not one bound to a hidden agent',
    async () => {
      const store = new TelegramStore(server.db());
      const connection = await store.getConnection({ tenant_id: TENANT, created_by: OWNER });
      if (connection === undefined) {
        throw new Error('the test bot is not connected');
      }
      const response = await server.request('/api/internal/telegram/updates', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${configuration.TRUEFORGE_API_KEY}` },
        body: JSON.stringify({
          connection_id: connection.id,
          update: {
            update_id: 1,
            message: {
              message_id: 1,
              from: { id: TELEGRAM_USER_ID, is_bot: false, first_name: 'Sam' },
              chat: { id: TELEGRAM_USER_ID, type: 'private' },
              date: Math.floor(Date.now() / 1000),
              text: 'Hello',
            },
          },
        }),
      });
      expect(response.status).toBe(204);
      const sessionId = (await store.getConnection({ tenant_id: TENANT, created_by: OWNER }))?.session_id ?? null;
      if (sessionId === null) {
        throw new Error('the Telegram message started no chat');
      }
      const session = await server.sessionStore().getSession({ tenant_id: TENANT, session_id: sessionId });
      expect(session?.title).toBe('Telegram');
      expect(session?.agent.type).toBe('inline');
    },
    TIMEOUT_MS,
  );
});

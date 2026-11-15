import { OpenAPIHono } from '@hono/zod-openapi';
import { Hono } from 'hono';
import winston from 'winston';

import {
  createTelegramSettingsRouter,
  createTelegramWebhookSecretMiddleware,
  readTelegramWebhookUpdate,
  TELEGRAM_SETTINGS_BASE_PATH,
  TELEGRAM_WEBHOOK_BASE_PATH,
} from '../../../src/apis/telegram';
import { STANDALONE_REQUEST_CONTEXT } from '../../../src/auth/identity';
import { telegramWebhookRoute } from '../../../src/routes/telegramRoutes';
import { TelegramApiError } from '../../../src/runtime/telegram/telegramClient';
import { createTelegramService } from '../../../src/runtime/telegram/telegramService';
import { RequestErrorResponseSchema } from '../../../src/schemas/errors';
import { GetTelegramAccountResponseSchema, type TelegramUpdate } from '../../../src/schemas/telegram';
import {
  FakeTelegramClient,
  fakeTelegramConnection,
  immediateQueue,
  InMemoryTelegramStore,
} from '../../fixtures/telegramFakes';

const logger = winston.createLogger({ silent: true });

/** The owner the standalone request context names, which the settings calls act for. */
const OWNER = { tenant_id: 'default', created_by: 'trueforge-default' };
const TOKEN = '123:good-token';

function makeSettingsApp() {
  const store = new InMemoryTelegramStore();
  const client = new FakeTelegramClient();
  const service = createTelegramService({ store, publicBaseUrl: 'http://localhost', createClient: () => client });
  const app = new Hono();
  app.route(
    TELEGRAM_SETTINGS_BASE_PATH,
    createTelegramSettingsRouter({
      telegramService: service,
      telegramStore: store,
      telegramQueue: immediateQueue,
      resolveRequestContext: () => STANDALONE_REQUEST_CONTEXT,
      logger,
    }),
  );
  return { app, store, client };
}

async function postJson(app: Hono, path: string, body: unknown): Promise<Response> {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function connect(app: Hono): Promise<Response> {
  return postJson(app, TELEGRAM_SETTINGS_BASE_PATH, { token: TOKEN });
}

/** Walks the connection to a waiting code, as a /start to the bot would. */
async function startPairing(store: InMemoryTelegramStore, expires_at: Date): Promise<void> {
  await store.startPairing({
    ...OWNER,
    code: '654321',
    expires_at,
    telegram_user_id: '555',
    chat_id: '777',
    display_name: 'Sam S',
  });
}

describe('the telegram settings endpoints', () => {
  it('reports no bot before one is connected', async () => {
    const { app } = makeSettingsApp();
    const response = await app.request(`${TELEGRAM_SETTINGS_BASE_PATH}/status`);
    expect(response.status).toBe(200);
    const body = GetTelegramAccountResponseSchema.parse(await response.json());
    expect(body.data).toEqual({
      available: true,
      state: 'not_connected',
      bot_name: null,
      bot_username: null,
      pairing_name: null,
    });
  });

  it('connects a bot Telegram accepts, and never sends the token back', async () => {
    const { app, store } = makeSettingsApp();
    const response = await connect(app);
    expect(response.status).toBe(201);
    const raw: unknown = await response.json();
    expect(JSON.stringify(raw)).not.toContain(TOKEN);
    const body = GetTelegramAccountResponseSchema.parse(raw);
    expect(body.data.state).toBe('awaiting_pairing');
    expect(body.data.bot_name).toBe('Test Bot');
    expect(store.connection?.bot_token).toBe(TOKEN);
  });

  it('saves nothing when Telegram refuses the token', async () => {
    const { app, store, client } = makeSettingsApp();
    client.getMe = () =>
      Promise.reject(new TelegramApiError({ message: 'Telegram said: Unauthorized', errorCode: 401, refused: true }));
    const response = await connect(app);
    expect(response.status).toBe(400);
    const body = RequestErrorResponseSchema.parse(await response.json());
    expect(body.error.message).toContain('Copy the token from BotFather again');
    expect(store.connection).toBeNull();
  });

  it('refuses to confirm when no code is waiting', async () => {
    const { app } = makeSettingsApp();
    await connect(app);
    const response = await postJson(app, `${TELEGRAM_SETTINGS_BASE_PATH}/confirm`, { code: '654321' });
    expect(response.status).toBe(400);
    const body = RequestErrorResponseSchema.parse(await response.json());
    expect(body.error.type).toBe('pairing');
    expect(body.error.message).toContain('No code is waiting');
  });

  it('refuses a wrong code and pairs nobody', async () => {
    const { app, store } = makeSettingsApp();
    await connect(app);
    await startPairing(store, new Date(Date.now() + 60_000));
    const response = await postJson(app, `${TELEGRAM_SETTINGS_BASE_PATH}/confirm`, { code: '000000' });
    expect(response.status).toBe(400);
    const body = RequestErrorResponseSchema.parse(await response.json());
    expect(body.error.type).toBe('pairing');
    expect(body.error.message).toContain('does not match');
    expect(store.connection?.paired_telegram_user_id).toBeNull();
  });

  it('refuses an expired code and clears it', async () => {
    const { app, store } = makeSettingsApp();
    await connect(app);
    await startPairing(store, new Date(Date.now() - 1000));
    const response = await postJson(app, `${TELEGRAM_SETTINGS_BASE_PATH}/confirm`, { code: '654321' });
    expect(response.status).toBe(400);
    const body = RequestErrorResponseSchema.parse(await response.json());
    expect(body.error.type).toBe('pairing');
    expect(body.error.message).toContain('expired');
    expect(store.connection?.pairing_code).toBeNull();
    expect(store.connection?.paired_telegram_user_id).toBeNull();
  });

  it('pairs on the right code, and the bot says hello in the paired chat', async () => {
    const { app, store, client } = makeSettingsApp();
    await connect(app);
    await startPairing(store, new Date(Date.now() + 60_000));
    const response = await postJson(app, `${TELEGRAM_SETTINGS_BASE_PATH}/confirm`, { code: '654321' });
    expect(response.status).toBe(200);
    const body = GetTelegramAccountResponseSchema.parse(await response.json());
    expect(body.data.state).toBe('connected');
    expect(store.connection?.paired_telegram_user_id).toBe('555');
    expect(store.connection?.pairing_code).toBeNull();
    expect(client.sent).toEqual([
      {
        chat_id: '777',
        text: 'You are paired. Send a message here and it will be answered in this chat.',
        inline_buttons: undefined,
      },
    ]);
  });

  it('names who is waiting to pair in the status, and never sends the code', async () => {
    const { app, store } = makeSettingsApp();
    await connect(app);
    await startPairing(store, new Date(Date.now() + 60_000));
    const response = await app.request(`${TELEGRAM_SETTINGS_BASE_PATH}/status`);
    expect(response.status).toBe(200);
    const raw: unknown = await response.json();
    expect(JSON.stringify(raw)).not.toContain('654321');
    const body = GetTelegramAccountResponseSchema.parse(raw);
    expect(body.data.state).toBe('awaiting_pairing');
    expect(body.data.pairing_name).toBe('Sam S');
  });

  it('cancelling a waiting pairing drops it, and the code no longer pairs', async () => {
    const { app, store } = makeSettingsApp();
    await connect(app);
    await startPairing(store, new Date(Date.now() + 60_000));
    const cancelled = await postJson(app, `${TELEGRAM_SETTINGS_BASE_PATH}/cancel-pairing`, {});
    expect(cancelled.status).toBe(200);
    const body = GetTelegramAccountResponseSchema.parse(await cancelled.json());
    expect(body.data.pairing_name).toBeNull();
    expect(store.connection?.pairing_code).toBeNull();
    expect(store.connection?.paired_telegram_user_id).toBeNull();
    const confirm = await postJson(app, `${TELEGRAM_SETTINGS_BASE_PATH}/confirm`, { code: '654321' });
    expect(confirm.status).toBe(400);
  });

  it('disconnect removes the bot and its token', async () => {
    const { app, store } = makeSettingsApp();
    await connect(app);
    const response = await app.request(TELEGRAM_SETTINGS_BASE_PATH, {
      method: 'DELETE',
      headers: { origin: 'http://localhost' },
    });
    expect(response.status).toBe(200);
    const body = GetTelegramAccountResponseSchema.parse(await response.json());
    expect(body.data.state).toBe('not_connected');
    expect(store.connection).toBeNull();
  });
});

describe('the telegram webhook route', () => {
  it('hands a readable update over and drops an unreadable one with success, never an error', async () => {
    const seen: (TelegramUpdate | undefined)[] = [];
    const app = new OpenAPIHono();
    app.openapi(telegramWebhookRoute, c => {
      seen.push(readTelegramWebhookUpdate(c.req.valid('json')));
      return c.body(null, 204);
    });
    const headers = { 'content-type': 'application/json' };
    const good = await app.request('/webhook', {
      method: 'POST',
      headers,
      body: JSON.stringify({ update_id: 9 }),
    });
    expect(good.status).toBe(204);
    // An update whose message this build cannot read: the door used to answer 400, which
    // Telegram retries forever. Now the handler sees it, reads nothing, and answers 204.
    const bad = await app.request('/webhook', {
      method: 'POST',
      headers,
      body: JSON.stringify({ update_id: 10, message: { chat: 'not-a-chat' } }),
    });
    expect(bad.status).toBe(204);
    expect(seen[0]?.update_id).toBe(9);
    expect(seen[1]).toBeUndefined();
  });
});

describe('the telegram webhook secret gate', () => {
  function makeWebhookApp() {
    const store = new InMemoryTelegramStore();
    store.connection = fakeTelegramConnection({ transport: 'webhook', webhook_secret: 's3cret' });
    const gated = new Hono();
    gated.use('*', createTelegramWebhookSecretMiddleware({ telegramStore: store }));
    gated.post('/webhook', c => c.body(null, 204));
    const app = new Hono();
    app.route(TELEGRAM_WEBHOOK_BASE_PATH, gated);
    return { app };
  }

  async function post(app: Hono, secret?: string): Promise<Response> {
    return app.request(`${TELEGRAM_WEBHOOK_BASE_PATH}/webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(secret === undefined ? {} : { 'x-telegram-bot-api-secret-token': secret }),
      },
      body: JSON.stringify({ update_id: 1 }),
    });
  }

  it('refuses a call with no secret before anything is handled', async () => {
    const { app } = makeWebhookApp();
    const response = await post(app);
    expect(response.status).toBe(401);
  });

  it('refuses a call with the wrong secret', async () => {
    const { app } = makeWebhookApp();
    const response = await post(app, 'not-the-secret');
    expect(response.status).toBe(401);
  });

  it('lets a call carrying the secret through', async () => {
    const { app } = makeWebhookApp();
    const response = await post(app, 's3cret');
    expect(response.status).toBe(204);
  });
});

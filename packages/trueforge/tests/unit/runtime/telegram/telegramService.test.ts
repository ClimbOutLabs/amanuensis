import { TelegramApiError } from '../../../../src/runtime/telegram/telegramClient';
import {
  createTelegramService,
  newPairingCode,
  TelegramSettingsError,
} from '../../../../src/runtime/telegram/telegramService';
import { FakeTelegramClient, InMemoryTelegramStore, TELEGRAM_TEST_OWNER } from '../../../fixtures/telegramFakes';

const SUBJECT = { subject_id: 'test-user', subject_type: 'owner', subject_display_name: 'Test User' };

function serviceWith(client: FakeTelegramClient, publicBaseUrl = 'http://localhost') {
  const store = new InMemoryTelegramStore();
  const service = createTelegramService({ store, publicBaseUrl, createClient: () => client });
  return { store, service };
}

function connectInput(token: string) {
  return { ...TELEGRAM_TEST_OWNER, token, created_by_subject: SUBJECT };
}

async function connectAndStartPairing(
  store: InMemoryTelegramStore,
  service: ReturnType<typeof serviceWith>['service'],
) {
  await service.connect(connectInput('123:good'));
  if (store.connection === null) {
    throw new Error('expected a saved connection');
  }
  await store.startPairing({
    ...TELEGRAM_TEST_OWNER,
    code: '123456',
    expires_at: new Date(Date.now() + 60_000),
    telegram_user_id: '555',
    chat_id: '777',
    display_name: 'Sam S',
  });
  return store.connection.id;
}

describe('telegram connection service', () => {
  it('connects a bot whose token Telegram accepts and saves no pairing yet', async () => {
    const { store, service } = serviceWith(new FakeTelegramClient());
    const status = await service.connect(connectInput('  123:good  '));
    expect(status).toEqual({
      available: true,
      state: 'awaiting_pairing',
      bot_name: 'Test Bot',
      bot_username: 'test_bot',
      pairing_name: null,
    });
    expect(store.connection?.bot_token).toBe('123:good');
  });

  it('saves nothing when Telegram refuses the token, and the error says what to do', async () => {
    const client = new FakeTelegramClient();
    client.getMe = () =>
      Promise.reject(new TelegramApiError({ message: 'Telegram said: Unauthorized', errorCode: 401, refused: true }));
    const { store, service } = serviceWith(client);
    const error: unknown = await service.connect(connectInput('123:bad')).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TelegramSettingsError);
    if (error instanceof TelegramSettingsError) {
      expect(error.status).toBe(400);
      expect(error.message).toContain('Copy the token from BotFather again');
    }
    expect(store.connection).toBeNull();
  });

  it('saves nothing when Telegram cannot be reached', async () => {
    const client = new FakeTelegramClient();
    client.getMe = () => Promise.reject(new Error('socket hang up'));
    const { store, service } = serviceWith(client);
    const error: unknown = await service.connect(connectInput('123:good')).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TelegramSettingsError);
    if (error instanceof TelegramSettingsError) {
      expect(error.status).toBe(502);
    }
    expect(store.connection).toBeNull();
  });

  it('uses a webhook only with a public https address, polling otherwise', async () => {
    const httpsClient = new FakeTelegramClient();
    const https = serviceWith(httpsClient, 'https://aman.example.com');
    await https.service.connect(connectInput('123:good'));
    expect(https.store.connection?.transport).toBe('webhook');
    expect(https.store.connection?.webhook_secret).not.toBeNull();
    expect(httpsClient.webhookUrls).toEqual(['https://aman.example.com/api/telegram/webhook']);

    const localClient = new FakeTelegramClient();
    const local = serviceWith(localClient, 'http://192.168.1.20:3000');
    await local.service.connect(connectInput('123:good'));
    expect(local.store.connection?.transport).toBe('polling');
    expect(localClient.deleteWebhookCalls).toBe(1);
  });

  it('pairs only on the code the bot sent, and clears the code once used', async () => {
    const { store, service } = serviceWith(new FakeTelegramClient());
    await connectAndStartPairing(store, service);

    const wrong: unknown = await service
      .confirmPairing({ ...TELEGRAM_TEST_OWNER, code: '999999' })
      .catch((caught: unknown) => caught);
    expect(wrong).toBeInstanceOf(TelegramSettingsError);
    expect(store.connection?.paired_telegram_user_id).toBeNull();

    const status = await service.confirmPairing({ ...TELEGRAM_TEST_OWNER, code: '123456' });
    expect(status.state).toBe('connected');
    expect(store.connection?.paired_telegram_user_id).toBe('555');
    expect(store.connection?.pairing_code).toBeNull();
  });

  it('refuses an expired code and clears it', async () => {
    const { store, service } = serviceWith(new FakeTelegramClient());
    await service.connect(connectInput('123:good'));
    await store.startPairing({
      ...TELEGRAM_TEST_OWNER,
      code: '123456',
      expires_at: new Date(Date.now() - 1000),
      telegram_user_id: '555',
      chat_id: '777',
      display_name: 'Sam S',
    });
    const error: unknown = await service
      .confirmPairing({ ...TELEGRAM_TEST_OWNER, code: '123456' })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TelegramSettingsError);
    expect(store.connection?.pairing_code).toBeNull();
    expect(store.connection?.paired_telegram_user_id).toBeNull();
  });

  it('names who is waiting to pair in the status, and never returns the code', async () => {
    const { store, service } = serviceWith(new FakeTelegramClient());
    await connectAndStartPairing(store, service);
    const status = await service.status(TELEGRAM_TEST_OWNER);
    expect(status.state).toBe('awaiting_pairing');
    expect(status.pairing_name).toBe('Sam S');
    expect(JSON.stringify(status)).not.toContain('123456');
  });

  it('cancelling drops the waiting pairing and pairs nobody', async () => {
    const { store, service } = serviceWith(new FakeTelegramClient());
    await connectAndStartPairing(store, service);
    const status = await service.cancelPairing(TELEGRAM_TEST_OWNER);
    expect(status.state).toBe('awaiting_pairing');
    expect(status.pairing_name).toBeNull();
    expect(store.connection?.pairing_code).toBeNull();
    expect(store.connection?.pairing_telegram_user_id).toBeNull();
    expect(store.connection?.paired_telegram_user_id).toBeNull();
    const error: unknown = await service
      .confirmPairing({ ...TELEGRAM_TEST_OWNER, code: '123456' })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TelegramSettingsError);
  });

  it('refuses to pair when the waiting code was replaced after it was read', async () => {
    const { store, service } = serviceWith(new FakeTelegramClient());
    await connectAndStartPairing(store, service);
    // A /start from someone else landed between the read and the write: the store's
    // conditional write no longer matches the code that was checked.
    store.confirmPairing = () => Promise.resolve(false);
    const error: unknown = await service
      .confirmPairing({ ...TELEGRAM_TEST_OWNER, code: '123456' })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TelegramSettingsError);
    if (error instanceof TelegramSettingsError) {
      expect(error.message).toContain('no longer the waiting one');
    }
    expect(store.connection?.paired_telegram_user_id).toBeNull();
  });

  it('disconnect removes the connection for good', async () => {
    const { store, service } = serviceWith(new FakeTelegramClient());
    await service.connect(connectInput('123:good'));
    const status = await service.disconnect(TELEGRAM_TEST_OWNER);
    expect(status.state).toBe('not_connected');
    expect(store.connection).toBeNull();
  });
});

describe('newPairingCode', () => {
  it('maps the drawn fraction onto six digits, padding with zeros', () => {
    expect(newPairingCode(() => 0)).toBe('000000');
    expect(newPairingCode(() => 0.5)).toBe('500000');
    expect(newPairingCode(() => 0.9999999)).toBe('999999');
  });

  it('always draws six digits from the default source', () => {
    for (let i = 0; i < 200; i += 1) {
      expect(newPairingCode()).toMatch(/^\d{6}$/);
    }
  });
});

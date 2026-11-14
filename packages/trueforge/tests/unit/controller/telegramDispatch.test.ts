import { Writable } from 'stream';
import winston from 'winston';

import { pollTelegramOnce, telegramPollBackoffMs } from '../../../src/controller/telegramDispatch';
import type { TelegramClient } from '../../../src/runtime/telegram/telegramClient';
import { createTelegramService } from '../../../src/runtime/telegram/telegramService';
import type { TelegramUpdate } from '../../../src/schemas/telegram';
import {
  fakePairedConnection,
  FakeTelegramClient,
  fakeTelegramConnection,
  InMemoryTelegramStore,
} from '../../fixtures/telegramFakes';

const logger = winston.createLogger({ silent: true });

function update(update_id: number): TelegramUpdate {
  return {
    update_id,
    message: {
      message_id: update_id,
      date: 1762000000,
      chat: { id: 777, type: 'private' },
      from: { id: 555, first_name: 'Person' },
      text: 'hi',
    },
  };
}

function harness(updates: TelegramUpdate[] | Error) {
  const store = new InMemoryTelegramStore();
  store.connection = fakePairedConnection();
  const client = new FakeTelegramClient();
  client.getUpdates = () => (updates instanceof Error ? Promise.reject(updates) : Promise.resolve(updates));
  const service = createTelegramService({ store, publicBaseUrl: 'http://localhost', createClient: () => client });
  const executed: number[] = [];
  const state = new Map<string, { failures: number; nextAttemptAt: number }>();
  const signal = new AbortController().signal;
  return { store, client, service, executed, state, signal };
}

describe('telegram poll backoff', () => {
  it('doubles from ten seconds and caps at a minute', () => {
    expect(telegramPollBackoffMs(1)).toBe(10_000);
    expect(telegramPollBackoffMs(2)).toBe(20_000);
    expect(telegramPollBackoffMs(3)).toBe(40_000);
    expect(telegramPollBackoffMs(4)).toBe(60_000);
    expect(telegramPollBackoffMs(12)).toBe(60_000);
  });
});

describe('pollTelegramOnce', () => {
  it('hands updates over in order and advances the stored offset past each accepted one', async () => {
    const { store, service, executed, state, signal } = harness([update(10), update(11)]);
    await pollTelegramOnce({
      store,
      service,
      executeUpdate: ({ update: handed }) => {
        executed.push(handed.update_id);
        return Promise.resolve();
      },
      logger,
      signal,
      state,
      now: () => 1_000_000,
    });
    expect(executed).toEqual([10, 11]);
    expect(store.connection?.poll_offset).toBe('12');
  });

  it('stops a connection at the first update the server refuses, and backs it off', async () => {
    const { store, service, state, signal } = harness([update(10), update(11)]);
    const pass = () =>
      pollTelegramOnce({
        store,
        service,
        executeUpdate: ({ update: handed }) =>
          handed.update_id === 11 ? Promise.reject(new Error('server down')) : Promise.resolve(),
        logger,
        signal,
        state,
        now: () => 1_000_000,
      });
    await pass();
    expect(store.connection?.poll_offset).toBe('11');
    expect(state.get('conn-1')).toEqual({ failures: 1, nextAttemptAt: 1_010_000 });

    // Inside the backoff window the connection is not polled again.
    let polls = 0;
    const counting = createTelegramService({
      store,
      publicBaseUrl: 'http://localhost',
      createClient: () => {
        const client: TelegramClient = new FakeTelegramClient();
        client.getUpdates = () => {
          polls += 1;
          return Promise.resolve([]);
        };
        return client;
      },
    });
    await pollTelegramOnce({
      store,
      service: counting,
      executeUpdate: () => Promise.resolve(),
      logger,
      signal,
      state,
      now: () => 1_005_000,
    });
    expect(polls).toBe(0);
  });

  it('moves past an update that could not be read and hands over the ones after it', async () => {
    // A skipped update arrives from the client as a bare update, carrying only its id.
    const { store, service, executed, state, signal } = harness([update(10), { update_id: 11 }, update(12)]);
    await pollTelegramOnce({
      store,
      service,
      executeUpdate: ({ update: handed }) => {
        executed.push(handed.update_id);
        return Promise.resolve();
      },
      logger,
      signal,
      state,
      now: () => 1_000_000,
    });
    expect(executed).toEqual([10, 11, 12]);
    expect(store.connection?.poll_offset).toBe('13');
    expect(state.get('conn-1')).toEqual({ failures: 0, nextAttemptAt: 0 });
  });

  it('logs an update the client skipped, and does not count it as a failure', async () => {
    const store = new InMemoryTelegramStore();
    store.connection = fakePairedConnection();
    const client = new FakeTelegramClient();
    client.getUpdates = (input: Parameters<TelegramClient['getUpdates']>[0]) => {
      input.onSkippedUpdate?.({ update_id: 11 });
      return Promise.resolve([update(12)]);
    };
    const service = createTelegramService({ store, publicBaseUrl: 'http://localhost', createClient: () => client });
    const chunks: string[] = [];
    const capturing = winston.createLogger({
      level: 'debug',
      format: winston.format.json(),
      transports: [
        new winston.transports.Stream({
          stream: new Writable({
            write(chunk: Buffer, _encoding, done) {
              chunks.push(chunk.toString());
              done();
            },
          }),
        }),
      ],
    });
    const state = new Map<string, { failures: number; nextAttemptAt: number }>();
    const executed: number[] = [];
    await pollTelegramOnce({
      store,
      service,
      executeUpdate: ({ update: handed }) => {
        executed.push(handed.update_id);
        return Promise.resolve();
      },
      logger: capturing,
      signal: new AbortController().signal,
      state,
      now: () => 1_000_000,
    });
    expect(executed).toEqual([12]);
    expect(store.connection?.poll_offset).toBe('13');
    expect(state.get('conn-1')?.failures).toBe(0);
    expect(chunks.join('')).toContain('A Telegram update could not be read and was skipped');
  });

  it('backs off when Telegram itself cannot be read', async () => {
    const { store, service, state, signal } = harness(new Error('network down'));
    await pollTelegramOnce({
      store,
      service,
      executeUpdate: () => Promise.resolve(),
      logger,
      signal,
      state,
      now: () => 500,
    });
    expect(state.get('conn-1')?.failures).toBe(1);
    expect(store.connection?.poll_offset).toBeNull();
  });

  it('never polls a webhook connection', async () => {
    const { store, service, state, signal } = harness([update(10)]);
    store.connection = fakeTelegramConnection({ transport: 'webhook', webhook_secret: 's3cret' });
    let polls = 0;
    const counting = createTelegramService({
      store,
      publicBaseUrl: 'https://aman.example.com',
      createClient: () => {
        const client: TelegramClient = new FakeTelegramClient();
        client.getUpdates = () => {
          polls += 1;
          return Promise.resolve([]);
        };
        return client;
      },
    });
    void service;
    await pollTelegramOnce({
      store,
      service: counting,
      executeUpdate: () => Promise.resolve(),
      logger,
      signal,
      state,
      now: () => 0,
    });
    expect(polls).toBe(0);
  });
});

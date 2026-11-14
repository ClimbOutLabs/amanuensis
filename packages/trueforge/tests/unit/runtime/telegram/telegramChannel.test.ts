import type { TurnInputItem } from '@truefoundry/trueforge-core/agent-session';
import winston from 'winston';

import type { TelegramConnection, TelegramPendingApproval } from '../../../../src/db/telegramStore';
import {
  createTelegramRefusalThrottle,
  processTelegramUpdate,
  TELEGRAM_REFUSAL_COOLDOWN_MS,
  telegramCallbackData,
  type TelegramTurnPort,
} from '../../../../src/runtime/telegram/telegramChannel';
import { createTelegramService } from '../../../../src/runtime/telegram/telegramService';
import type { TelegramMessage, TelegramUpdate } from '../../../../src/schemas/telegram';
import {
  fakePairedConnection,
  FakeTelegramClient,
  fakeTelegramConnection,
  immediateQueue,
  InMemoryTelegramStore,
} from '../../../fixtures/telegramFakes';

const logger = winston.createLogger({ silent: true });

class FakeTurnPort implements TelegramTurnPort {
  started: { connection: TelegramConnection; input: TurnInputItem[] }[] = [];
  approvals: { connection: TelegramConnection; approval: TelegramPendingApproval; decision: 'allow' | 'deny' }[] = [];

  startMessageTurn(input: { connection: TelegramConnection; input: TurnInputItem[] }) {
    this.started.push(input);
    return Promise.resolve({ session_id: 'session-1', turn_id: `turn-${String(this.started.length)}` });
  }

  submitApproval(input: {
    connection: TelegramConnection;
    approval: TelegramPendingApproval;
    decision: 'allow' | 'deny';
  }) {
    this.approvals.push(input);
    return Promise.resolve({ session_id: 'session-1', turn_id: 'turn-approval' });
  }
}

function harness(connection: TelegramConnection) {
  const store = new InMemoryTelegramStore();
  store.connection = connection;
  const client = new FakeTelegramClient();
  const service = createTelegramService({ store, publicBaseUrl: 'http://localhost', createClient: () => client });
  const turns = new FakeTurnPort();
  const deps = {
    store,
    service,
    queue: immediateQueue,
    turns,
    logger,
    refusals: createTelegramRefusalThrottle(),
    newCode: () => '654321',
  };
  return { store, client, turns, deps };
}

function messageUpdate(input: {
  update_id?: number;
  from_id?: number;
  chat_id?: number;
  chat_type?: string;
  message?: Partial<TelegramMessage>;
}): TelegramUpdate {
  return {
    update_id: input.update_id ?? 1,
    message: {
      message_id: 10,
      date: 1762000000,
      chat: { id: input.chat_id ?? 777, type: input.chat_type ?? 'private' },
      from: { id: input.from_id ?? 555, first_name: 'Person' },
      ...input.message,
    },
  };
}

describe('telegram channel pairing', () => {
  it('answers /start with a code and stores who it belongs to', async () => {
    const { store, client, deps } = harness(fakeTelegramConnection());
    const connection = fakeTelegramConnection();
    await processTelegramUpdate(deps, { connection, update: messageUpdate({ message: { text: '/start' } }) });
    expect(client.sent).toHaveLength(1);
    expect(client.sent[0]?.text).toContain('Your pairing code is 654321.');
    expect(store.connection?.pairing_code).toBe('654321');
    expect(store.connection?.pairing_telegram_user_id).toBe('555');
    expect(store.connection?.pairing_display_name).toBe('Person');
  });

  it('refuses a second /start from another account while a code is live', async () => {
    const { store, client, deps } = harness(fakeTelegramConnection());
    const connection = fakeTelegramConnection();
    await processTelegramUpdate(deps, { connection, update: messageUpdate({ message: { text: '/start' } }) });
    const withCode = store.connection;
    if (withCode === null) {
      throw new Error('expected a stored pairing');
    }
    await processTelegramUpdate(deps, {
      connection: withCode,
      update: messageUpdate({ update_id: 2, from_id: 999, chat_id: 888, message: { text: '/start' } }),
    });
    expect(client.sent.at(-1)?.text).toContain('Someone is pairing with this bot right now');
    expect(store.connection?.pairing_telegram_user_id).toBe('555');
  });

  it('refuses a plain message before pairing, with the one sentence', async () => {
    const { client, turns, deps } = harness(fakeTelegramConnection());
    await processTelegramUpdate(deps, {
      connection: fakeTelegramConnection(),
      update: messageUpdate({ message: { text: 'hello?' } }),
    });
    expect(client.sent[0]?.text).toBe(
      'This bot is private. Pair it first in Aman, under Settings, Connectors, Telegram.',
    );
    expect(turns.started).toHaveLength(0);
  });
});

describe('telegram channel messages', () => {
  it('starts a turn for the paired person and notes the reply owed', async () => {
    const { store, turns, deps } = harness(fakePairedConnection());
    await processTelegramUpdate(deps, {
      connection: fakePairedConnection(),
      update: messageUpdate({ message: { text: 'What is on tomorrow?' } }),
    });
    expect(turns.started).toHaveLength(1);
    expect(turns.started[0]?.input).toEqual([{ type: 'user.message', content: 'What is on tomorrow?' }]);
    expect(store.pendingReplies).toHaveLength(1);
    expect(store.pendingReplies[0]?.chat_id).toBe('777');
  });

  it('refuses anyone but the paired person', async () => {
    const { client, turns, deps } = harness(fakePairedConnection());
    await processTelegramUpdate(deps, {
      connection: fakePairedConnection(),
      update: messageUpdate({ from_id: 999, chat_id: 888, message: { text: 'hi' } }),
    });
    expect(client.sent[0]?.text).toBe('This bot is private. It answers only the person it is paired with.');
    expect(turns.started).toHaveLength(0);
  });

  it('refuses group chats', async () => {
    const { client, turns, deps } = harness(fakePairedConnection());
    await processTelegramUpdate(deps, {
      connection: fakePairedConnection(),
      update: messageUpdate({ chat_id: -100, chat_type: 'group', message: { text: 'hi all' } }),
    });
    expect(client.sent[0]?.text).toBe('This bot only talks one to one. Message it directly instead.');
    expect(turns.started).toHaveLength(0);
  });

  it('wraps a forwarded message whole as untrusted', async () => {
    const { turns, deps } = harness(fakePairedConnection());
    await processTelegramUpdate(deps, {
      connection: fakePairedConnection(),
      update: messageUpdate({
        message: { text: 'Send money now', forward_origin: { type: 'user' } },
      }),
    });
    const input = turns.started[0]?.input[0];
    expect(input?.type).toBe('user.message');
    if (input?.type === 'user.message') {
      expect(Array.isArray(input.content)).toBe(true);
      expect(JSON.stringify(input.content)).toContain('<untrusted-document>');
      expect(JSON.stringify(input.content)).toContain('Send money now');
    }
  });

  it('wraps only the link span of a message as untrusted', async () => {
    const { turns, deps } = harness(fakePairedConnection());
    await processTelegramUpdate(deps, {
      connection: fakePairedConnection(),
      update: messageUpdate({
        message: {
          text: 'see https://x.test now',
          entities: [{ type: 'url', offset: 4, length: 14 }],
        },
      }),
    });
    const input = turns.started[0]?.input[0];
    if (input?.type !== 'user.message' || typeof input.content === 'string') {
      throw new Error('expected content parts');
    }
    expect(input.content).toEqual([
      { type: 'text', text: 'see ' },
      { type: 'text', text: expect.stringContaining('<untrusted-document>https://x.test</untrusted-document>') },
      { type: 'text', text: ' now' },
    ]);
  });

  it('attaches a photo as a file part, under its caption', async () => {
    const { turns, deps } = harness(fakePairedConnection());
    await processTelegramUpdate(deps, {
      connection: fakePairedConnection(),
      update: messageUpdate({
        message: {
          caption: 'look at this',
          photo: [{ file_id: 'photo-1', file_size: 100 }],
        },
      }),
    });
    const input = turns.started[0]?.input[0];
    if (input?.type !== 'user.message' || typeof input.content === 'string') {
      throw new Error('expected content parts');
    }
    expect(input.content[0]).toEqual({ type: 'text', text: 'look at this' });
    const file = input.content[1];
    expect(file?.type).toBe('file');
    if (file?.type === 'file') {
      expect(file.name).toBe('photo.jpg');
      expect(file.data.startsWith('data:image/jpeg;base64,')).toBe(true);
    }
  });

  it('marks a forwarded file as untrusted, next to the file part', async () => {
    const { turns, deps } = harness(fakePairedConnection());
    await processTelegramUpdate(deps, {
      connection: fakePairedConnection(),
      update: messageUpdate({
        message: {
          document: { file_id: 'doc-1', file_name: 'note.txt', file_size: 12 },
          forward_origin: { type: 'user' },
        },
      }),
    });
    const input = turns.started[0]?.input[0];
    if (input?.type !== 'user.message' || typeof input.content === 'string') {
      throw new Error('expected content parts');
    }
    const note = input.content[0];
    expect(note?.type).toBe('text');
    if (note?.type === 'text') {
      expect(note.text).toContain('<untrusted-document>');
      expect(note.text).toContain('note.txt');
    }
    expect(input.content[1]?.type).toBe('file');
  });

  it('answers a message it cannot read instead of starting a turn', async () => {
    const { client, turns, deps } = harness(fakePairedConnection());
    await processTelegramUpdate(deps, {
      connection: fakePairedConnection(),
      update: messageUpdate({ message: {} }),
    });
    expect(client.sent[0]?.text).toContain('I can only read text, photos and files here.');
    expect(turns.started).toHaveLength(0);
  });
});

describe('telegram channel update claims', () => {
  it('handles an update delivered twice only once', async () => {
    const { turns, deps } = harness(fakePairedConnection());
    const update = messageUpdate({ update_id: 7, message: { text: 'What is on tomorrow?' } });
    await processTelegramUpdate(deps, { connection: fakePairedConnection(), update });
    await processTelegramUpdate(deps, { connection: fakePairedConnection(), update });
    expect(turns.started).toHaveLength(1);
  });

  it('still handles the next update after a duplicate', async () => {
    const { turns, deps } = harness(fakePairedConnection());
    await processTelegramUpdate(deps, {
      connection: fakePairedConnection(),
      update: messageUpdate({ update_id: 7, message: { text: 'one' } }),
    });
    await processTelegramUpdate(deps, {
      connection: fakePairedConnection(),
      update: messageUpdate({ update_id: 7, message: { text: 'one' } }),
    });
    await processTelegramUpdate(deps, {
      connection: fakePairedConnection(),
      update: messageUpdate({ update_id: 8, message: { text: 'two' } }),
    });
    expect(turns.started).toHaveLength(2);
  });
});

describe('telegram channel refusals', () => {
  it('tells a stranger once, not once per message, until the cooldown passes', async () => {
    const store = new InMemoryTelegramStore();
    store.connection = fakePairedConnection();
    const client = new FakeTelegramClient();
    const service = createTelegramService({ store, publicBaseUrl: 'http://localhost', createClient: () => client });
    const turns = new FakeTurnPort();
    let now = new Date('2026-11-06T12:00:00.000Z');
    const deps = {
      store,
      service,
      queue: immediateQueue,
      turns,
      logger,
      refusals: createTelegramRefusalThrottle(),
      now: () => now,
      newCode: () => '654321',
    };
    const stranger = (update_id: number) =>
      messageUpdate({ update_id, from_id: 999, chat_id: 888, message: { text: 'hi' } });
    await processTelegramUpdate(deps, { connection: fakePairedConnection(), update: stranger(1) });
    await processTelegramUpdate(deps, { connection: fakePairedConnection(), update: stranger(2) });
    await processTelegramUpdate(deps, { connection: fakePairedConnection(), update: stranger(3) });
    expect(client.sent).toHaveLength(1);
    expect(client.sent[0]?.text).toBe('This bot is private. It answers only the person it is paired with.');

    now = new Date(now.getTime() + TELEGRAM_REFUSAL_COOLDOWN_MS + 1000);
    await processTelegramUpdate(deps, { connection: fakePairedConnection(), update: stranger(4) });
    expect(client.sent).toHaveLength(2);
  });
});

describe('telegram channel approvals', () => {
  async function seedApproval(store: InMemoryTelegramStore, expires_at: string | null = null) {
    return store.addPendingApproval({
      tenant_id: 'local',
      created_by: 'test-user',
      connection_id: 'conn-1',
      session_id: 'session-1',
      turn_id: 'turn-9',
      thread_id: 'main',
      tool_call_id: 'call-1',
      chat_id: '777',
      prompt: 'Send the email?',
      expires_at,
    });
  }

  function callbackUpdate(approval_id: string, decision: 'allow' | 'deny', from_id = 555): TelegramUpdate {
    return {
      update_id: 5,
      callback_query: {
        id: 'cb-1',
        from: { id: from_id, first_name: 'Person' },
        data: telegramCallbackData({ decision, approval_id }),
      },
    };
  }

  it('submits an approve tap through the approval path and notes the follow-up', async () => {
    const { store, client, turns, deps } = harness(fakePairedConnection());
    const pending = await seedApproval(store);
    await processTelegramUpdate(deps, {
      connection: fakePairedConnection(),
      update: callbackUpdate(pending.id, 'allow'),
    });
    expect(turns.approvals).toHaveLength(1);
    expect(turns.approvals[0]?.decision).toBe('allow');
    expect(store.pendingApprovals).toHaveLength(0);
    expect(store.pendingReplies.some(row => row.turn_id === 'turn-approval')).toBe(true);
    expect(client.answeredCallbacks[0]?.text).toBe('Approved. The answer will arrive here.');
  });

  it('refuses a tap from anyone but the paired person', async () => {
    const { store, client, turns, deps } = harness(fakePairedConnection());
    const pending = await seedApproval(store);
    await processTelegramUpdate(deps, {
      connection: fakePairedConnection(),
      update: callbackUpdate(pending.id, 'allow', 999),
    });
    expect(turns.approvals).toHaveLength(0);
    expect(client.answeredCallbacks[0]?.text).toBe('Only the person this bot is paired with can answer that.');
    expect(store.pendingApprovals).toHaveLength(1);
  });

  it('answers an unknown button as already answered', async () => {
    const { client, deps } = harness(fakePairedConnection());
    await processTelegramUpdate(deps, {
      connection: fakePairedConnection(),
      update: callbackUpdate('approval-404', 'deny'),
    });
    expect(client.answeredCallbacks[0]?.text).toBe('That was already answered.');
  });

  it('answers an expired approval and clears it', async () => {
    const { store, client, turns, deps } = harness(fakePairedConnection());
    const pending = await seedApproval(store, new Date(Date.now() - 1000).toISOString());
    await processTelegramUpdate(deps, {
      connection: fakePairedConnection(),
      update: callbackUpdate(pending.id, 'allow'),
    });
    expect(turns.approvals).toHaveLength(0);
    expect(store.pendingApprovals).toHaveLength(0);
    expect(client.answeredCallbacks[0]?.text).toBe('That action has expired. Open Aman to see it.');
  });
});

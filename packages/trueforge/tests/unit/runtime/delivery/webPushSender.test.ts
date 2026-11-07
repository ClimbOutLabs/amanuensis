import { buildPushPayload } from '@block65/webcrypto-web-push';

import type { IPushSubscriptionStore, PushTarget } from '../../../../src/db/pushSubscriptionStore';
import { createWebPushSender, pushBody, pushTitle } from '../../../../src/runtime/delivery/webPushSender';
import type { Delivery } from '../../../../src/schemas/deliveries';

jest.mock('@block65/webcrypto-web-push', () => ({
  buildPushPayload: jest.fn(),
}));

const mockedBuild = jest.mocked(buildPushPayload);

const SETTINGS = { publicKey: 'pub', privateKey: 'priv', subject: 'mailto:owner@example.invalid' };
const OWNER = { tenant_id: 't1', created_by: 'alice' };

function delivery(overrides: Partial<Pick<Delivery, 'level'>> = {}): Delivery {
  return {
    id: 'd1',
    kind: 'reminder',
    level: overrides.level ?? 'nudge',
    text: 'Pick up the secret parcel from Dana',
    reason: 'You asked to be reminded on Monday.',
    link: { type: 'chat', session_id: 's1' },
    created_at: '2026-10-31T10:00:00.000Z',
    seen_at: null,
    attempts: [],
  };
}

function subscriptions(targets: PushTarget[]) {
  const removed: string[] = [];
  const store: IPushSubscriptionStore = {
    save: () => Promise.reject(new Error('not used')),
    listTargets: () => Promise.resolve(targets),
    hasEndpoint: () => Promise.reject(new Error('not used')),
    removeByEndpoint: () => Promise.resolve(false),
    removeById: ({ id }) => {
      removed.push(id);
      return Promise.resolve(true);
    },
  };
  return { store, removed };
}

const TARGET_A: PushTarget = {
  id: 'a',
  endpoint: 'https://push.example.test/a',
  p256dh: 'p',
  auth: 'x',
  server_key: 'pub',
};
const TARGET_B: PushTarget = {
  id: 'b',
  endpoint: 'https://push.example.test/b',
  p256dh: 'p',
  auth: 'x',
  server_key: 'pub',
};

beforeEach(() => {
  mockedBuild.mockReset();
  mockedBuild.mockResolvedValue({
    method: 'POST',
    headers: {
      authorization: 'vapid',
      ttl: '60',
      'content-encoding': 'aes128gcm',
      'content-length': '0',
      'content-type': 'application/octet-stream',
    },
    body: new Uint8Array(),
  });
});

describe('push payload', () => {
  it('carries the item id and a short title, and none of the reminder text or reason', () => {
    const item = delivery();
    const body = pushBody(item);
    expect(JSON.parse(body)).toEqual({ delivery_id: 'd1', title: 'Reminder' });
    expect(body).not.toContain('parcel');
    expect(body).not.toContain('Dana');
    expect(body).not.toContain('Monday');
  });

  it('names no assistant and gives each kind plain words', () => {
    expect(pushTitle('nudge')).toBe('Something needs you today');
    for (const kind of ['reminder', 'note', 'nudge', 'approval_waiting'] as const) {
      expect(pushTitle(kind)).not.toMatch(/mannie|aman/i);
    }
  });

  it('hands only that body to the push library, once per device', async () => {
    const { store } = subscriptions([TARGET_A, TARGET_B]);
    const sender = createWebPushSender({
      subscriptions: store,
      settings: SETTINGS,
      fetchPush: () => Promise.resolve({ status: 201 }),
    });

    const attempts = await sender.send({ delivery: delivery(), ...OWNER, test: false });

    expect(attempts.map(a => [a.channel, a.outcome, a.target])).toEqual([
      ['web_push', 'sent', 'a'],
      ['web_push', 'sent', 'b'],
    ]);
    expect(mockedBuild).toHaveBeenCalledTimes(2);
    for (const [message] of mockedBuild.mock.calls) {
      expect(message.data).toBe(JSON.stringify({ delivery_id: 'd1', title: 'Reminder' }));
    }
  });
});

describe('web push sender', () => {
  it('removes a device the push service says is gone, and keeps the others', async () => {
    const { store, removed } = subscriptions([TARGET_A, TARGET_B]);
    const sender = createWebPushSender({
      subscriptions: store,
      settings: SETTINGS,
      fetchPush: url => Promise.resolve({ status: url.endsWith('/a') ? 410 : 201 }),
    });

    const attempts = await sender.send({ delivery: delivery(), ...OWNER, test: false });

    expect(removed).toEqual(['a']);
    expect(attempts.map(a => [a.target, a.outcome])).toEqual([
      ['a', 'gone'],
      ['b', 'sent'],
    ]);
  });

  it('also removes a device on 404, but not on a server error', async () => {
    const { store, removed } = subscriptions([TARGET_A, TARGET_B]);
    const sender = createWebPushSender({
      subscriptions: store,
      settings: SETTINGS,
      fetchPush: url => Promise.resolve({ status: url.endsWith('/a') ? 404 : 503 }),
    });

    const attempts = await sender.send({ delivery: delivery(), ...OWNER, test: false });

    expect(removed).toEqual(['a']);
    expect(attempts.map(a => a.outcome)).toEqual(['gone', 'failed']);
  });

  it('records a failure when the push service cannot be reached, and never throws', async () => {
    const { store, removed } = subscriptions([TARGET_A]);
    const sender = createWebPushSender({
      subscriptions: store,
      settings: SETTINGS,
      fetchPush: () => Promise.reject(new Error('offline')),
    });

    const attempts = await sender.send({ delivery: delivery(), ...OWNER, test: false });

    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ outcome: 'failed' });
    expect(removed).toEqual([]);
  });

  it('keeps a note in the app and sends nothing', async () => {
    const { store } = subscriptions([TARGET_A]);
    const fetchPush = jest.fn(() => Promise.resolve({ status: 201 }));
    const sender = createWebPushSender({ subscriptions: store, settings: SETTINGS, fetchPush });

    await expect(sender.send({ delivery: delivery({ level: 'note' }), ...OWNER, test: false })).resolves.toEqual([]);
    expect(fetchPush).not.toHaveBeenCalled();
  });

  it('leaves a call to the phone: a push goes out only if the call is missed', async () => {
    const { store } = subscriptions([TARGET_A]);
    const fetchPush = jest.fn(() => Promise.resolve({ status: 201 }));
    const sender = createWebPushSender({ subscriptions: store, settings: SETTINGS, fetchPush });

    await expect(sender.send({ delivery: delivery({ level: 'call' }), ...OWNER, test: false })).resolves.toEqual([]);
    expect(fetchPush).not.toHaveBeenCalled();
  });

  it('skips every device and says why when push is not set up', async () => {
    const { store } = subscriptions([TARGET_A]);
    const fetchPush = jest.fn(() => Promise.resolve({ status: 201 }));
    const sender = createWebPushSender({ subscriptions: store, settings: undefined, fetchPush });

    const attempts = await sender.send({ delivery: delivery(), ...OWNER, test: false });

    expect(attempts).toMatchObject([{ outcome: 'skipped', detail: 'Push is not set up on this server.' }]);
    expect(fetchPush).not.toHaveBeenCalled();
  });

  it('removes a device set up with an older key instead of sending to it', async () => {
    const { store, removed } = subscriptions([{ ...TARGET_A, server_key: 'old' }, TARGET_B]);
    const fetchPush = jest.fn(() => Promise.resolve({ status: 201 }));
    const sender = createWebPushSender({ subscriptions: store, settings: SETTINGS, fetchPush });

    const attempts = await sender.send({ delivery: delivery(), ...OWNER, test: false });

    expect(attempts.map(a => [a.target, a.outcome])).toEqual([
      ['a', 'gone'],
      ['b', 'sent'],
    ]);
    expect(attempts[0]?.detail).toMatch(/Turn notices on there again/);
    expect(removed).toEqual(['a']);
    expect(fetchPush).toHaveBeenCalledTimes(1);
  });

  it('keeps no more than a few pushes in flight at once', async () => {
    const targets = Array.from({ length: 10 }, (_, index) => ({
      ...TARGET_A,
      id: String(index),
      endpoint: `https://push.example.test/${String(index)}`,
    }));
    const { store } = subscriptions(targets);
    let inFlight = 0;
    let most = 0;
    const sender = createWebPushSender({
      subscriptions: store,
      settings: SETTINGS,
      fetchPush: async () => {
        inFlight += 1;
        most = Math.max(most, inFlight);
        await new Promise(resolve => setTimeout(resolve, 1));
        inFlight -= 1;
        return { status: 201 };
      },
    });

    const attempts = await sender.send({ delivery: delivery(), ...OWNER, test: false });

    expect(attempts.map(a => a.target)).toEqual(targets.map(target => target.id));
    expect(most).toBeLessThanOrEqual(4);
  });

  it('sends nothing when the person has no device', async () => {
    const { store } = subscriptions([]);
    const sender = createWebPushSender({ subscriptions: store, settings: SETTINGS });
    await expect(sender.send({ delivery: delivery(), ...OWNER, test: false })).resolves.toEqual([]);
  });
});

describe('web push sender, outside addresses', () => {
  it('never calls an address that points inside the network, and removes the device', async () => {
    const { store, removed } = subscriptions([
      { id: 'lan', endpoint: 'https://internal.example.test/push', p256dh: 'p', auth: 'x', server_key: 'pub' },
      { id: 'loopback', endpoint: 'https://127.0.0.1/push', p256dh: 'p', auth: 'x', server_key: 'pub' },
    ]);
    const sender = createWebPushSender({
      subscriptions: store,
      settings: SETTINGS,
      resolveAddresses: () => Promise.resolve(['10.0.0.5']),
    });

    const attempts = await sender.send({ delivery: delivery(), ...OWNER, test: false });

    expect(attempts.map(a => [a.target, a.outcome])).toEqual([
      ['lan', 'gone'],
      ['loopback', 'gone'],
    ]);
    expect(removed.sort()).toEqual(['lan', 'loopback']);
  });

  it('keeps a device whose name could not be looked up, since that may pass', async () => {
    const { store, removed } = subscriptions([TARGET_A]);
    const sender = createWebPushSender({
      subscriptions: store,
      settings: SETTINGS,
      resolveAddresses: () => Promise.reject(new Error('dns down')),
    });
    const attempts = await sender.send({ delivery: delivery(), ...OWNER, test: false });
    expect(attempts.map(a => a.outcome)).toEqual(['failed']);
    expect(removed).toEqual([]);
  });
});

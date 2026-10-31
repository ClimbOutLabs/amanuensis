import { OpenAPIHono } from '@hono/zod-openapi';

import { createDeliveriesRouter, createPushRouter } from '../../../src/apis/deliveries';
import type { RequestContext } from '../../../src/auth/identity';
import { DeliveryStore } from '../../../src/db/deliveryStore';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { PushSubscriptionStore } from '../../../src/db/pushSubscriptionStore';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import {
  GetDeliveryResponseSchema,
  GetPushSubscriptionResponseSchema,
  ListDeliveriesResponseSchema,
} from '../../../src/schemas/deliveries';

function person(id: string): RequestContext {
  return {
    tenant_id: 'default',
    subject: { id, type: 'user', display_name: id },
    roles: [],
    user_credential: null,
  };
}

async function build({ pushOn = true }: { pushOn?: boolean } = {}) {
  const publicKey = pushOn ? 'PUBLIC' : undefined;
  const db = createSqliteDb(':memory:');
  await migrateSqliteToLatest(db);
  const deliveryStore = new DeliveryStore(db);
  const pushSubscriptionStore = new PushSubscriptionStore(db);
  let current = person('alice');
  const resolveRequestContext = () => current;
  const app = new OpenAPIHono();
  app.route('/deliveries', createDeliveriesRouter({ deliveryStore, resolveRequestContext }));
  app.route('/push', createPushRouter({ pushSubscriptionStore, publicKey, resolveRequestContext }));
  const as = (id: string) => {
    current = person(id);
  };
  const json = (path: string, init?: { method: string; body: unknown }) =>
    app.request(path, {
      method: init?.method ?? 'GET',
      headers: { 'content-type': 'application/json' },
      ...(init === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  const give = (created_by: string, text: string) =>
    deliveryStore.create({
      tenant_id: 'default',
      created_by,
      kind: 'reminder',
      level: 'nudge',
      text,
      reason: 'You asked for it.',
      link: { type: 'chat', session_id: 's1' },
    });
  return { as, json, give, deliveryStore };
}

describe('deliveries routes', () => {
  it('shows the unread count to a tab that never set a reminder', async () => {
    const { json, give } = await build();
    await give('alice', 'one');
    await give('alice', 'two');

    const response = await json('/deliveries/unread-count');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: { unread_count: 2 } });
  });

  it('lists newest first, in pages', async () => {
    const { json, give } = await build();
    await give('alice', 'older');
    await new Promise(resolve => setTimeout(resolve, 5));
    await give('alice', 'newer');

    const first = ListDeliveriesResponseSchema.parse(await (await json('/deliveries?limit=1')).json());
    expect(first.data.map(d => d.text)).toEqual(['newer']);
    const second = ListDeliveriesResponseSchema.parse(
      await (await json(`/deliveries?limit=1&page_token=${String(first.next_page_token)}`)).json(),
    );
    expect(second.data.map(d => d.text)).toEqual(['older']);
    expect(second.next_page_token).toBeUndefined();
  });

  it('marks seen on the server, so every device agrees', async () => {
    const { json, give } = await build();
    const a = await give('alice', 'one');
    await give('alice', 'two');

    // The phone marks one item seen; the laptop then asks.
    const marked = await json('/deliveries/seen', { method: 'POST', body: { ids: [a.id] } });
    await expect(marked.json()).resolves.toEqual({ data: { unread_count: 1 } });
    const laptop = await json('/deliveries/unread-count');
    await expect(laptop.json()).resolves.toEqual({ data: { unread_count: 1 } });
    const one = GetDeliveryResponseSchema.parse(await (await json(`/deliveries/${a.id}`)).json());
    expect(one.data.seen_at).not.toBeNull();
  });

  it('never shows or marks another person’s deliveries', async () => {
    const { json, give, as, deliveryStore } = await build();
    const bobs = await give('bob', 'bobs private reminder');
    await give('alice', 'mine');

    as('alice');
    const list = ListDeliveriesResponseSchema.parse(await (await json('/deliveries')).json());
    expect(list.data.map(d => d.text)).toEqual(['mine']);
    expect((await json(`/deliveries/${bobs.id}`)).status).toBe(404);
    const attempt = await json('/deliveries/seen', { method: 'POST', body: { ids: [bobs.id] } });
    expect(attempt.status).toBe(200);
    await expect(deliveryStore.countUnread({ tenant_id: 'default', created_by: 'bob' })).resolves.toBe(1);

    as('bob');
    await expect((await json('/deliveries/unread-count')).json()).resolves.toEqual({ data: { unread_count: 1 } });
  });

  it('refuses an empty list of ids', async () => {
    const { json } = await build();
    expect((await json('/deliveries/seen', { method: 'POST', body: { ids: [] } })).status).toBe(400);
  });
});

describe('push routes', () => {
  const subscription = { endpoint: 'https://push.example.test/abc', keys: { p256dh: 'p', auth: 'a' }, label: 'Laptop' };

  it('hands out the public key, or null while push is off', async () => {
    const on = await build();
    await expect((await on.json('/push/config')).json()).resolves.toEqual({ data: { public_key: 'PUBLIC' } });
    const off = await build({ pushOn: false });
    await expect((await off.json('/push/config')).json()).resolves.toEqual({ data: { public_key: null } });
  });

  it('saves a device once and removes it on request', async () => {
    const { json } = await build();
    const first = await json('/push/subscriptions', { method: 'POST', body: subscription });
    expect(first.status).toBe(201);
    const again = await json('/push/subscriptions', { method: 'POST', body: subscription });
    expect(GetPushSubscriptionResponseSchema.parse(await again.json()).data.id).toBe(
      GetPushSubscriptionResponseSchema.parse(await first.json()).data.id,
    );

    const removed = await json(`/push/subscriptions?endpoint=${encodeURIComponent(subscription.endpoint)}`, {
      method: 'DELETE',
      body: undefined,
    });
    expect(removed.status).toBe(200);
  });

  it('refuses a device address that is not https', async () => {
    const { json } = await build();
    const response = await json('/push/subscriptions', {
      method: 'POST',
      body: { ...subscription, endpoint: 'http://push.example.test/abc' },
    });
    expect(response.status).toBe(400);
  });

  it('refuses a device while push is off, and says what to do', async () => {
    const { json } = await build({ pushOn: false });
    const response = await json('/push/subscriptions', { method: 'POST', body: subscription });
    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toContain('Ask the person who runs it');
  });
});

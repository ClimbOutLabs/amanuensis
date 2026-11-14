import { generateKeyPairSync, randomBytes } from 'node:crypto';

import { OpenAPIHono } from '@hono/zod-openapi';
import { AgentSpecSchema, Sessions, type CreatedBySubject } from '@truefoundry/trueforge-core/agent-session';

import { createDeliveriesRouter, createPushRouter } from '../../../src/apis/deliveries';
import type { RequestContext } from '../../../src/auth/identity';
import { DeliveryStore } from '../../../src/db/deliveryStore';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { PushSubscriptionStore } from '../../../src/db/pushSubscriptionStore';
import { SqliteAgentStore } from '../../../src/db/sqlite/agent-store/SqliteAgentStore';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteSessionStore } from '../../../src/db/sqlite/session-store/SqliteSessionStore';
import {
  GetDeliveryResponseSchema,
  GetPushSubscriptionResponseSchema,
  ListDeliveriesResponseSchema,
  LookupPushSubscriptionResponseSchema,
  type DeliveryLink,
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
  const sessionStore = new SqliteSessionStore(db);
  const agentStore = new SqliteAgentStore(db);
  const agentSubject: CreatedBySubject = { subject_id: 'alice', subject_type: 'user', subject_display_name: 'alice' };
  const agent = await agentStore.createAgent({
    host_managed: true,
    tenant_id: 'default',
    created_by_subject: agentSubject,
    name: 'assistant-test',
    description: 'Runs the chats in these tests.',
    manifest: AgentSpecSchema.parse({ model: { name: 'test-provider/test-model' }, instructions: 'test' }),
    external_id: null,
  });
  const sessions = new Sessions({ sessionStore });
  const makeChat = async (session_id: string, owner = 'alice') => {
    await sessions.create({
      tenant_id: 'default',
      session_id,
      created_by_subject:
        owner === 'alice' ? agentSubject : { subject_id: owner, subject_type: 'user', subject_display_name: owner },
      agent: { type: 'reference', id: agent.id, name: agent.name },
      external_id: null,
    });
  };
  let current = person('alice');
  const resolveRequestContext = () => current;
  const app = new OpenAPIHono();
  app.route('/deliveries', createDeliveriesRouter({ deliveryStore, sessionStore, resolveRequestContext }));
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
  const giveLinked = (input: { created_by: string; text: string; link: DeliveryLink | null }) =>
    deliveryStore.create({
      tenant_id: 'default',
      created_by: input.created_by,
      kind: 'reminder',
      level: 'nudge',
      text: input.text,
      reason: 'You asked for it.',
      link: input.link,
    });
  const give = (created_by: string, text: string) =>
    giveLinked({ created_by, text, link: { type: 'chat', session_id: 's1' } });
  const giveApproval = (input: { created_by: string; text: string; session_id: string }) =>
    deliveryStore.create({
      tenant_id: 'default',
      created_by: input.created_by,
      kind: 'approval_waiting',
      level: 'call',
      text: input.text,
      reason: 'A card is waiting.',
      link: { type: 'approval', session_id: input.session_id, approval_id: 'appr-1' },
    });
  return { as, json, give, giveLinked, giveApproval, makeChat, deliveryStore, sessionStore };
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

  it('answers a bad page token with 400 and what to do', async () => {
    const { json } = await build();
    const response = await json('/deliveries?page_token=not-a-token');
    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toContain('Reload');
  });

  it('marks every unread item seen, past what one page holds', async () => {
    const { json, give } = await build();
    for (let index = 0; index < 120; index += 1) {
      await give('alice', `item ${String(index)}`);
    }
    const response = await json('/deliveries/seen-all', { method: 'POST', body: {} });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: { unread_count: 0 } });
  });

  it('refuses an empty list of ids', async () => {
    const { json } = await build();
    expect((await json('/deliveries/seen', { method: 'POST', body: { ids: [] } })).status).toBe(400);
  });
});

describe('links to chats that are gone', () => {
  it('keeps the link while the chat is there, on the list and on a single read', async () => {
    const { json, giveLinked, makeChat } = await build();
    await makeChat('live-chat');
    const made = await giveLinked({
      created_by: 'alice',
      text: 'still here',
      link: { type: 'chat', session_id: 'live-chat' },
    });

    const list = ListDeliveriesResponseSchema.parse(await (await json('/deliveries')).json());
    expect(list.data[0]?.link).toEqual({ type: 'chat', session_id: 'live-chat' });
    const one = GetDeliveryResponseSchema.parse(await (await json(`/deliveries/${made.id}`)).json());
    expect(one.data.link).toEqual({ type: 'chat', session_id: 'live-chat' });
  });

  it('serves an item without its link when the chat was deleted, on the list and on a single read', async () => {
    const { json, giveLinked } = await build();
    const made = await giveLinked({
      created_by: 'alice',
      text: 'the chat is gone',
      link: { type: 'chat', session_id: 'deleted-chat' },
    });

    const list = ListDeliveriesResponseSchema.parse(await (await json('/deliveries')).json());
    expect(list.data[0]?.text).toBe('the chat is gone');
    expect(list.data[0]?.link).toBeNull();
    const one = GetDeliveryResponseSchema.parse(await (await json(`/deliveries/${made.id}`)).json());
    expect(one.data.text).toBe('the chat is gone');
    expect(one.data.link).toBeNull();
  });

  it('serves an approval link without the link when its chat was deleted', async () => {
    const { json, giveLinked } = await build();
    await giveLinked({
      created_by: 'alice',
      text: 'the card chat is gone',
      link: { type: 'approval', session_id: 'deleted-chat', approval_id: 'appr-1' },
    });

    const list = ListDeliveriesResponseSchema.parse(await (await json('/deliveries')).json());
    expect(list.data[0]?.link).toBeNull();
  });

  it('serves an item without its link when the chat belongs to someone else', async () => {
    const { json, giveLinked, makeChat } = await build();
    await makeChat('bobs-chat', 'bob');
    const made = await giveLinked({
      created_by: 'alice',
      text: 'not her chat',
      link: { type: 'chat', session_id: 'bobs-chat' },
    });

    const list = ListDeliveriesResponseSchema.parse(await (await json('/deliveries')).json());
    expect(list.data[0]?.text).toBe('not her chat');
    expect(list.data[0]?.link).toBeNull();
    const one = GetDeliveryResponseSchema.parse(await (await json(`/deliveries/${made.id}`)).json());
    expect(one.data.link).toBeNull();
  });

  it('keeps an approval item with its link while its chat is there', async () => {
    const { json, giveApproval, makeChat } = await build();
    await makeChat('card-chat');
    await giveApproval({ created_by: 'alice', text: 'waiting on you', session_id: 'card-chat' });

    const list = ListDeliveriesResponseSchema.parse(await (await json('/deliveries')).json());
    expect(list.data[0]?.kind).toBe('approval_waiting');
    expect(list.data[0]?.link).toEqual({ type: 'approval', session_id: 'card-chat', approval_id: 'appr-1' });
  });

  it('resolves an approval item when its chat was deleted', async () => {
    const { json, giveApproval } = await build();
    const made = await giveApproval({ created_by: 'alice', text: 'the card chat is gone', session_id: 'deleted-chat' });

    const list = ListDeliveriesResponseSchema.parse(await (await json('/deliveries')).json());
    expect(list.data).toEqual([]);
    expect((await json(`/deliveries/${made.id}`)).status).toBe(404);
  });

  it('resolves an approval item when its chat belongs to someone else', async () => {
    const { json, giveApproval, makeChat } = await build();
    await makeChat('bobs-card-chat', 'bob');
    await giveApproval({ created_by: 'alice', text: 'not her card', session_id: 'bobs-card-chat' });

    const list = ListDeliveriesResponseSchema.parse(await (await json('/deliveries')).json());
    expect(list.data).toEqual([]);
  });

  it('takes an approval item out of the unread count once its chat is deleted', async () => {
    const { json, give, giveApproval, makeChat, sessionStore, deliveryStore } = await build();
    await makeChat('card-chat');
    const approval = await giveApproval({ created_by: 'alice', text: 'waiting on you', session_id: 'card-chat' });
    await give('alice', 'a reminder');
    await expect((await json('/deliveries/unread-count')).json()).resolves.toEqual({ data: { unread_count: 2 } });

    await sessionStore.deleteSession({ tenant_id: 'default', session_id: 'card-chat' });

    await expect((await json('/deliveries/unread-count')).json()).resolves.toEqual({ data: { unread_count: 1 } });
    const stored = await deliveryStore.get({ tenant_id: 'default', created_by: 'alice', id: approval.id });
    expect(stored?.seen_at).not.toBeNull();
  });

  it('marks an approval item seen in the store when the feed leaves it out', async () => {
    const { json, giveApproval, deliveryStore } = await build();
    const approval = await giveApproval({
      created_by: 'alice',
      text: 'the card chat is gone',
      session_id: 'gone-chat',
    });

    ListDeliveriesResponseSchema.parse(await (await json('/deliveries')).json());

    expect(await deliveryStore.countUnread({ tenant_id: 'default', created_by: 'alice' })).toBe(0);
    const stored = await deliveryStore.get({ tenant_id: 'default', created_by: 'alice', id: approval.id });
    expect(stored?.seen_at).not.toBeNull();
  });

  it('looks up chat ownership once for a whole page', async () => {
    const { json, giveLinked, makeChat, sessionStore } = await build();
    await makeChat('live-chat');
    await giveLinked({ created_by: 'alice', text: 'one', link: { type: 'chat', session_id: 'live-chat' } });
    await giveLinked({ created_by: 'alice', text: 'two', link: { type: 'chat', session_id: 'deleted-chat' } });
    await giveLinked({ created_by: 'alice', text: 'three', link: { type: 'space', space_id: 'space-1' } });
    const spy = jest.spyOn(sessionStore, 'getOwnedIds');

    const list = ListDeliveriesResponseSchema.parse(await (await json('/deliveries')).json());
    expect(list.data).toHaveLength(3);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({
      tenant_id: 'default',
      subject_id: 'alice',
      ids: expect.arrayContaining(['live-chat', 'deleted-chat']),
    });
  });

  it('never checks a space link against the chats', async () => {
    const { json, giveLinked } = await build();
    await giveLinked({
      created_by: 'alice',
      text: 'a space, not a chat',
      link: { type: 'space', space_id: 'space-1' },
    });

    const list = ListDeliveriesResponseSchema.parse(await (await json('/deliveries')).json());
    expect(list.data[0]?.link).toEqual({ type: 'space', space_id: 'space-1' });
  });
});

/** A real device key pair's public half, as a browser hands it over. */
function devicePoint(): string {
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return publicKey.export({ format: 'der', type: 'spki' }).subarray(-65).toString('base64url');
}

describe('push routes', () => {
  const subscription = {
    endpoint: 'https://push.example.test/abc',
    keys: { p256dh: devicePoint(), auth: randomBytes(16).toString('base64url') },
    label: 'Laptop',
  };

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

    const removed = await json('/push/subscriptions', { method: 'DELETE', body: { endpoint: subscription.endpoint } });
    expect(removed.status).toBe(200);
  });

  it('says whether a device still gets notices, only to its owner', async () => {
    const { json, as } = await build();
    const lookup = async () =>
      LookupPushSubscriptionResponseSchema.parse(
        await (
          await json('/push/subscriptions/lookup', { method: 'POST', body: { endpoint: subscription.endpoint } })
        ).json(),
      ).data.saved;
    expect(await lookup()).toBe(false);
    expect((await json('/push/subscriptions', { method: 'POST', body: subscription })).status).toBe(201);
    expect(await lookup()).toBe(true);
    as('bob');
    expect(await lookup()).toBe(false);
    as('alice');
    await json('/push/subscriptions', { method: 'DELETE', body: { endpoint: subscription.endpoint } });
    expect(await lookup()).toBe(false);
  });

  it('refuses device keys that are not real push keys', async () => {
    const { json } = await build();
    const notOnCurve = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString('base64url');
    for (const keys of [
      { ...subscription.keys, p256dh: 'p' },
      { ...subscription.keys, p256dh: notOnCurve },
      { ...subscription.keys, auth: 'a' },
    ]) {
      const response = await json('/push/subscriptions', { method: 'POST', body: { ...subscription, keys } });
      expect(response.status).toBe(400);
    }
  });

  it('never hands one person’s device address to another', async () => {
    const { json, as } = await build();
    expect((await json('/push/subscriptions', { method: 'POST', body: subscription })).status).toBe(201);
    as('bob');
    const response = await json('/push/subscriptions', { method: 'POST', body: subscription });
    expect(response.status).toBe(409);
    expect(JSON.stringify(await response.json())).toContain('Turn notices on again');
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

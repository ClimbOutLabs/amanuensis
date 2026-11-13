import { OpenAPIHono } from '@hono/zod-openapi';
import winston from 'winston';

import { createNoticingRouter } from '../../../src/apis/noticing';
import { createReachRouter } from '../../../src/apis/reach';
import type { RequestContext } from '../../../src/auth/identity';
import { DeliveryStore } from '../../../src/db/deliveryStore';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { NoticingStore } from '../../../src/db/noticingStore';
import { ReachSettingsStore } from '../../../src/db/reachSettingsStore';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { TextContactStore } from '../../../src/db/textContactStore';
import { claimTestCall } from '../../../src/runtime/calls/testCallClaim';
import type { DeliveryChannelSender } from '../../../src/runtime/delivery/deliveryChannel';
import { createDeliveryService } from '../../../src/runtime/delivery/deliveryService';
import type { ChannelViewer } from '../../../src/runtime/noticing/reachChannels';
import { NO_PHONE_CHANNELS, reachChannelsFor } from '../../../src/runtime/noticing/reachChannels';
import type { ReachAvailability } from '../../../src/schemas/reach';
import { defaultReachSettings, GetReachResponseSchema, type ReachSettings } from '../../../src/schemas/reach';
import { confirmNumber } from '../../fixtures/confirmedNumber';

const NOW = new Date('2026-11-05T15:00:00.000Z');

function person(id: string): RequestContext {
  return { tenant_id: 'default', subject: { id, type: 'user', display_name: id }, roles: [], user_credential: null };
}

/** A phone that rings for every call, unless `refuse` gives the words for turning the call away. */
function ringing(
  onRing: (input: Parameters<DeliveryChannelSender['send']>[0]) => void,
  refuse: (input: Parameters<DeliveryChannelSender['send']>[0]) => Promise<string | undefined> = () =>
    Promise.resolve(undefined),
): DeliveryChannelSender {
  return {
    channel: 'call',
    async send(input) {
      const refused = await refuse(input);
      if (refused !== undefined) {
        return [
          { channel: 'call', outcome: 'skipped', detail: refused, target: null, attempted_at: NOW.toISOString() },
        ];
      }
      onRing(input);
      return [
        {
          channel: 'call',
          outcome: 'sent',
          detail: 'The phone is ringing.',
          target: 'ending 0111',
          attempted_at: NOW.toISOString(),
        },
      ];
    },
  };
}

async function build({
  channels = () => NO_PHONE_CHANNELS,
  memories = [],
  callSender,
}: {
  channels?: (input?: { viewer: ChannelViewer }) => ReachAvailability;
  memories?: string[];
  /** Stands in for the phone, given the text contact store so it can count test calls the way the real one does. */
  callSender?: (contacts: TextContactStore) => DeliveryChannelSender;
} = {}) {
  const db = createSqliteDb(':memory:');
  await migrateSqliteToLatest(db);
  const reachStore = new ReachSettingsStore(db);
  const noticingStore = new NoticingStore(db);
  const deliveryStore = new DeliveryStore(db);
  const textContacts = new TextContactStore(db);
  const deliveryService = createDeliveryService({
    store: deliveryStore,
    senders: callSender === undefined ? [] : [callSender(textContacts)],
    audit: { record: () => Promise.resolve() },
    logger: winston.createLogger({ silent: true }),
  });
  let current = person('alice');
  let offered = channels;
  let at = NOW;
  const app = new OpenAPIHono();
  app.route(
    '/reach',
    createReachRouter({
      reachStore,
      textContacts,
      noticingStore,
      deliveryService,
      channels: input => offered(input),
      isInstanceOwner: owner => owner.created_by === 'alice',
      memories: () => Promise.resolve(memories),
      resolveRequestContext: () => current,
      logger: winston.createLogger({ silent: true }),
      now: () => at,
    }),
  );
  const call = (path: string, init?: { method: string; body: unknown }) =>
    app.request(`/reach${path}`, {
      method: init?.method ?? 'GET',
      headers: { 'content-type': 'application/json' },
      ...(init === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  const put = (settings: ReachSettings) => call('', { method: 'PUT', body: { settings } });
  return {
    call,
    put,
    reachStore,
    noticingStore,
    deliveryStore,
    textContacts,
    as: (id: string) => {
      current = person(id);
    },
    /** Moves the server's clock forward. */
    later: (ms: number) => {
      at = new Date(at.getTime() + ms);
    },
    /** The channels the server offers from now on, as when the voice parts stop. */
    offer: (next: ReachAvailability) => {
      offered = () => next;
    },
  };
}

describe('reach routes', () => {
  it('words a problem with texts for whoever runs Aman, and tells everyone else whom to ask', async () => {
    const { call, as } = await build({
      channels: input =>
        reachChannelsFor({
          twilio: { accountSid: 'AC' },
          voice: 'ready',
          numberProblem: 'not_accepted',
          viewer: input?.viewer ?? 'person',
        }),
    });
    const owner = GetReachResponseSchema.parse(await (await call('')).json()).data;
    expect(owner.availability.texts.problem).toContain('Copy the account id and auth token');
    as('bob');
    const other = GetReachResponseSchema.parse(await (await call('')).json()).data;
    expect(other.availability.texts.problem).toBe(
      'STOP replies do not reach Aman yet. Ask the person who runs Aman to check the Twilio settings.',
    );
  });

  it('starts quiet and unsaved, with phone channels shown as not set up', async () => {
    const { call } = await build();
    const response = await call('');
    expect(response.status).toBe(200);
    const { data } = GetReachResponseSchema.parse(await response.json());
    expect(data.saved).toBe(false);
    expect(data.settings.call_kinds).toEqual([]);
    expect(data.settings.channels).toEqual({ texts: false, calls: false });
    expect(data.settings.noticing_on).toBe(false);
    expect(data.availability.calls).toEqual(NO_PHONE_CHANNELS.calls);
    expect(data.availability.calls.available).toBe(false);
    expect(data.availability.calls.problem).toBeNull();
    expect(data.max_levels.bill_due).toBe('nudge');
    expect(data.max_levels.calendar_clash).toBe('call');
  });

  describe('when mail checks keep failing', () => {
    const OWNER = { tenant_id: 'default', created_by: 'alice' };
    const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);
    const failingSince = (minutes: number) => ({
      checked_at: minutesAgo(minutes),
      failure: { kind: 'too_slow' as const, since: minutesAgo(minutes) },
      stuck: undefined,
      source: undefined,
    });
    /** Someone who turned the background checks on, so their trouble is shown. */
    const watching = async () => {
      const built = await build();
      await built.reachStore.put({ ...OWNER, settings: { ...defaultReachSettings('UTC'), noticing_on: true } });
      return built;
    };

    it('says where mail is read from once it has been checked', async () => {
      const { call, noticingStore } = await watching();
      expect(GetReachResponseSchema.parse(await (await call('')).json()).data.mail_source).toBeNull();
      await noticingStore.setCheckpoint({ ...OWNER, watcher: 'mail', ...failingSince(5), source: 'email_connector' });
      expect(GetReachResponseSchema.parse(await (await call('')).json()).data.mail_source).toBe('email_connector');
    });

    it('says whether the mail read from reports sender confirmation, as its checkpoint recorded', async () => {
      const { call, noticingStore } = await watching();
      expect(GetReachResponseSchema.parse(await (await call('')).json()).data.mail_sender_confirmation).toBeNull();
      await noticingStore.setCheckpoint({
        ...OWNER,
        watcher: 'mail',
        ...failingSince(5),
        source: 'email_connector',
        sender_confirmation: false,
      });
      expect(GetReachResponseSchema.parse(await (await call('')).json()).data.mail_sender_confirmation).toBe(false);
      await noticingStore.setCheckpoint({
        ...OWNER,
        watcher: 'mail',
        ...failingSince(5),
        source: 'google',
        sender_confirmation: true,
      });
      expect(GetReachResponseSchema.parse(await (await call('')).json()).data.mail_sender_confirmation).toBe(true);
    });

    it('says nothing about mail that works, or that has failed for less than an hour', async () => {
      const { call, noticingStore } = await watching();
      expect(GetReachResponseSchema.parse(await (await call('')).json()).data.mail_problem).toBeNull();
      await noticingStore.setCheckpoint({ ...OWNER, watcher: 'mail', ...failingSince(59) });
      expect(GetReachResponseSchema.parse(await (await call('')).json()).data.mail_problem).toBeNull();
    });

    it('shows trouble when the mail read so far is an hour behind, even when no pass recorded a failure', async () => {
      const { call, noticingStore } = await watching();
      await noticingStore.setCheckpoint({
        ...OWNER,
        watcher: 'mail',
        checked_at: minutesAgo(90),
        failure: undefined,
        stuck: undefined,
        source: 'google',
      });
      const mine = GetReachResponseSchema.parse(await (await call('')).json()).data;
      expect(mine.mail_problem).toEqual({ since: minutesAgo(90).toISOString(), kind: 'too_slow' });
    });

    it('shows no trouble when an old failure is on record but mail has been read up to a few minutes ago', async () => {
      const { call, noticingStore } = await watching();
      await noticingStore.setCheckpoint({
        ...OWNER,
        watcher: 'mail',
        ...failingSince(300),
        checked_at: minutesAgo(10),
      });
      expect(GetReachResponseSchema.parse(await (await call('')).json()).data.mail_problem).toBeNull();
    });

    it('says when the calendar has not been checked for about an hour', async () => {
      const { call, noticingStore } = await watching();
      const calendar = { ...failingSince(60), failure: { kind: 'other' as const, since: minutesAgo(60) } };
      await noticingStore.setCheckpoint({ ...OWNER, watcher: 'calendar', ...calendar });
      expect(GetReachResponseSchema.parse(await (await call('')).json()).data.calendar_problem).toEqual({
        since: minutesAgo(60).toISOString(),
        kind: 'other',
      });
      await noticingStore.setCheckpoint({
        ...OWNER,
        watcher: 'calendar',
        ...calendar,
        failure: { kind: 'google_sign_in', since: minutesAgo(90) },
      });
      expect(GetReachResponseSchema.parse(await (await call('')).json()).data.calendar_problem).toEqual({
        since: minutesAgo(90).toISOString(),
        kind: 'google_sign_in',
      });
      await noticingStore.setCheckpoint({
        ...OWNER,
        watcher: 'calendar',
        ...calendar,
        failure: { kind: 'other', since: minutesAgo(10) },
      });
      expect(GetReachResponseSchema.parse(await (await call('')).json()).data.calendar_problem).toBeNull();
    });

    it('says when mail was last checked well and why not since, after about an hour', async () => {
      const { call, noticingStore, as } = await watching();
      await noticingStore.setCheckpoint({ ...OWNER, watcher: 'mail', ...failingSince(60) });
      const mine = GetReachResponseSchema.parse(await (await call('')).json()).data;
      expect(mine.mail_problem).toEqual({ since: minutesAgo(60).toISOString(), kind: 'too_slow' });
      as('bob');
      expect(GetReachResponseSchema.parse(await (await call('')).json()).data.mail_problem).toBeNull();
    });

    it('shows no trouble and no watched mailbox while the background checks are off', async () => {
      const { call, noticingStore, reachStore } = await watching();
      await noticingStore.setCheckpoint({ ...OWNER, watcher: 'mail', ...failingSince(90), source: 'google' });
      await noticingStore.setCheckpoint({ ...OWNER, watcher: 'calendar', ...failingSince(90) });
      const on = GetReachResponseSchema.parse(await (await call('')).json()).data;
      expect(on.mail_problem).not.toBeNull();
      expect(on.calendar_problem).not.toBeNull();
      expect(on.mail_source).toBe('google');
      await reachStore.put({ ...OWNER, settings: defaultReachSettings('UTC') });
      const off = GetReachResponseSchema.parse(await (await call('')).json()).data;
      expect(off.settings.noticing_on).toBe(false);
      expect([off.mail_problem, off.calendar_problem, off.mail_source, off.mail_sender_confirmation]).toEqual([
        null,
        null,
        null,
        null,
      ]);
    });
  });

  it('saves settings per person and reads them back', async () => {
    const { put, call, as } = await build();
    const settings = { ...defaultReachSettings('Europe/Paris'), max_nudges_per_day: 3 };
    expect((await put(settings)).status).toBe(200);
    const mine = GetReachResponseSchema.parse(await (await call('')).json()).data;
    expect(mine.saved).toBe(true);
    expect(mine.settings.max_nudges_per_day).toBe(3);
    as('bob');
    const his = GetReachResponseSchema.parse(await (await call('')).json()).data;
    expect(his.saved).toBe(false);
  });

  it('refuses to switch on texts or calls that are not set up', async () => {
    const { put, call } = await build();
    const base = defaultReachSettings('UTC');
    expect((await put({ ...base, channels: { texts: true, calls: false } })).status).toBe(400);
    const calls = await put({ ...base, channels: { texts: false, calls: true } });
    expect(calls.status).toBe(400);
    // One next step: the note already says what to do.
    await expect(calls.json()).resolves.toEqual({ error: { message: NO_PHONE_CHANNELS.calls.note } });
    const tried = await call('/test', { method: 'POST', body: { channel: 'call' } });
    await expect(tried.json()).resolves.toEqual({ error: { message: NO_PHONE_CHANNELS.calls.note } });
  });

  it('allows calls once the channel is available and the number is confirmed, and says what to do before that', async () => {
    const channels: ReachAvailability = {
      ...NO_PHONE_CHANNELS,
      calls: { available: true, note: 'On.', problem: null },
    };
    const { put, textContacts } = await build({ channels: () => channels });
    const early = await put({ ...defaultReachSettings('UTC'), channels: { texts: false, calls: true } });
    expect(early.status).toBe(400);
    expect(JSON.stringify(await early.json())).toContain('Confirm your number first, then switch calls on.');
    await confirmNumber({
      store: textContacts,
      owner: { tenant_id: 'default', created_by: 'alice' },
      phone: '+15550111',
      now: NOW,
    });
    expect((await put({ ...defaultReachSettings('UTC'), channels: { texts: false, calls: true } })).status).toBe(200);
  });

  it('keeps calls on, and saves other changes, while calls are briefly not available', async () => {
    const channels: ReachAvailability = {
      ...NO_PHONE_CHANNELS,
      calls: { available: true, note: 'On.', problem: null },
    };
    const { put, textContacts, offer } = await build({ channels: () => channels });
    await confirmNumber({
      store: textContacts,
      owner: { tenant_id: 'default', created_by: 'alice' },
      phone: '+15550111',
      now: NOW,
    });
    const on = { ...defaultReachSettings('UTC'), channels: { texts: false, calls: true } };
    expect((await put(on)).status).toBe(200);
    offer({
      ...NO_PHONE_CHANNELS,
      calls: { available: false, note: 'Calls need the voice parts of Aman.', problem: null },
    });
    expect((await put({ ...on, max_nudges_per_day: 2 })).status).toBe(200);
  });

  it('rings the phone on Try it for calls, without using up the time between calls', async () => {
    const channels: ReachAvailability = {
      ...NO_PHONE_CHANNELS,
      calls: { available: true, note: 'On.', problem: null },
    };
    const placed: string[] = [];
    const { call, put, textContacts, deliveryStore } = await build({
      channels: () => channels,
      callSender: () => ringing(({ delivery, test }) => placed.push(`${delivery.kind}:${String(test)}`)),
    });
    const early = await call('/test', { method: 'POST', body: { channel: 'call' } });
    expect(early.status).toBe(409);
    await confirmNumber({
      store: textContacts,
      owner: { tenant_id: 'default', created_by: 'alice' },
      phone: '+15550111',
      now: NOW,
    });
    expect((await put({ ...defaultReachSettings('UTC'), channels: { texts: false, calls: true } })).status).toBe(200);
    const tried = await call('/test', { method: 'POST', body: { channel: 'call' } });
    expect(tried.status).toBe(201);
    expect(placed).toEqual(['note:true']);
    await expect(
      deliveryStore.lastCreatedAt({ tenant_id: 'default', created_by: 'alice', levels: ['call'] }),
    ).resolves.toBeUndefined();
  });

  it('rings on Try it at most once every 2 minutes and 5 times a day, and says when to try again', async () => {
    const channels: ReachAvailability = {
      ...NO_PHONE_CHANNELS,
      calls: { available: true, note: 'On.', problem: null },
    };
    let placed = 0;
    let at = NOW;
    const { call, put, textContacts, later } = await build({
      channels: () => channels,
      callSender: contacts =>
        ringing(
          () => {
            placed += 1;
          },
          async ({ tenant_id, created_by }) => {
            const claim = await claimTestCall({ store: contacts, owner: { tenant_id, created_by }, at });
            return claim.ok ? undefined : claim.message;
          },
        ),
    });
    await confirmNumber({
      store: textContacts,
      owner: { tenant_id: 'default', created_by: 'alice' },
      phone: '+15550111',
      now: NOW,
    });
    expect((await put({ ...defaultReachSettings('UTC'), channels: { texts: false, calls: true } })).status).toBe(200);
    const tryIt = () => call('/test', { method: 'POST', body: { channel: 'call' } });
    expect((await tryIt()).status).toBe(201);
    const soon = await tryIt();
    expect(soon.status).toBe(429);
    expect(JSON.stringify(await soon.json())).toContain('Wait 2 minutes, then try again.');
    for (let i = 0; i < 4; i += 1) {
      later(2 * 60_000);
      at = new Date(at.getTime() + 2 * 60_000);
      expect((await tryIt()).status).toBe(201);
    }
    later(2 * 60_000);
    at = new Date(at.getTime() + 2 * 60_000);
    const sixth = await tryIt();
    expect(sixth.status).toBe(429);
    expect(JSON.stringify(await sixth.json())).toContain('That was 5 test calls today.');
    expect(placed).toBe(5);
  });

  it('refuses a call tick for a kind that can never call', async () => {
    const { put } = await build();
    expect((await put({ ...defaultReachSettings('UTC'), call_kinds: ['bill_due'] })).status).toBe(400);
    expect((await put({ ...defaultReachSettings('UTC'), call_kinds: ['travel'] })).status).toBe(200);
  });

  it('stamps a new always-important sender on the server and keeps the first time after that', async () => {
    const { put, reachStore } = await build();
    const sender = {
      address: 'dana@example.com',
      source: 'settings' as const,
      added_at: '1999-01-01T00:00:00.000Z',
    };
    await put({ ...defaultReachSettings('UTC'), always_important: [sender, sender] });
    const saved = await reachStore.get({ tenant_id: 'default', created_by: 'alice' });
    expect(saved?.always_important).toEqual([{ ...sender, added_at: NOW.toISOString() }]);
    await put({ ...defaultReachSettings('UTC'), always_important: [{ ...sender, name: 'Dana' }] });
    const again = await reachStore.get({ tenant_id: 'default', created_by: 'alice' });
    expect(again?.always_important).toEqual([{ ...sender, name: 'Dana', added_at: NOW.toISOString() }]);
  });

  it('suggests addresses from memory and leaves out turned-down ones', async () => {
    const { call, put } = await build({ memories: ['Dana is dana@example.com', 'Sam is sam@example.com'] });
    await put({ ...defaultReachSettings('UTC'), dismissed_suggestions: ['sam@example.com'] });
    const response = await call('/suggestions');
    await expect(response.json()).resolves.toEqual({
      data: [{ address: 'dana@example.com', memory: 'Dana is dana@example.com' }],
    });
  });

  it('tries in-app quietly and push loudly, both as notes in the feed, and says plainly that texts and calls are not set up', async () => {
    const { call, deliveryStore } = await build();
    const inApp = await call('/test', { method: 'POST', body: { channel: 'in_app' } });
    expect(inApp.status).toBe(201);
    const push = await call('/test', { method: 'POST', body: { channel: 'push' } });
    expect(push.status).toBe(201);
    const tried = (await deliveryStore.list({ tenant_id: 'default', created_by: 'alice', limit: 10 })).deliveries;
    expect(tried.map(item => item.level).sort()).toEqual(['note', 'nudge']);
    // A test never counts toward the day's nudges, which count only nudges the assistant noticed.
    expect(tried.map(item => item.kind)).toEqual(['note', 'note']);
    const text = await call('/test', { method: 'POST', body: { channel: 'text' } });
    expect(text.status).toBe(409);
    await expect(text.json()).resolves.toEqual({
      error: { message: `${NO_PHONE_CHANNELS.texts.note} Try the app or push notices for now.` },
    });
  });
});

describe('internal noticing route', () => {
  it('runs the named watcher and returns its counts', async () => {
    const run = jest.fn().mockResolvedValue({ owners: 2, raised: 1 });
    const app = new OpenAPIHono();
    app.route('/n', createNoticingRouter({ noticing: { run } }));
    const response = await app.request('/n/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ watcher: 'calendar' }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: { owners: 2, raised: 1 } });
    expect(run).toHaveBeenCalledWith({ watcher: 'calendar' });
    const bad = await app.request('/n/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ watcher: 'sms' }),
    });
    expect(bad.status).toBe(400);
  });
});

import winston from 'winston';

import { DeliveryStore } from '../../../../src/db/deliveryStore';
import { migrateSqliteToLatest } from '../../../../src/db/migrateSqlite';
import { createSqliteDb } from '../../../../src/db/sqlite/client';
import type { DeliveryChannelSender } from '../../../../src/runtime/delivery/deliveryChannel';
import { createDeliveryService } from '../../../../src/runtime/delivery/deliveryService';
import type { DeliveryAttempt, DeliveryChannel } from '../../../../src/schemas/deliveries';

const OWNER = { tenant_id: 'default', created_by: 'dana' };
const AT = '2026-11-06T15:00:00.000Z';

function sender({
  channel,
  outcome,
  fallsBackTo,
  throws = false,
}: {
  channel: DeliveryChannel;
  outcome: DeliveryAttempt['outcome'];
  fallsBackTo?: readonly DeliveryChannel[];
  throws?: boolean;
}): DeliveryChannelSender {
  return {
    channel,
    ...(fallsBackTo === undefined ? {} : { fallsBackTo }),
    send: ({ delivery }) => {
      if (throws) {
        return Promise.reject(new Error('down'));
      }
      // The call channel acts on calls only; the others on nudges, as the real ones do.
      const acts = channel === 'call' ? delivery.level === 'call' : delivery.level === 'nudge';
      return Promise.resolve(acts ? [{ channel, outcome, detail: null, target: null, attempted_at: AT }] : []);
    },
  };
}

async function setup(senders: DeliveryChannelSender[]) {
  const db = createSqliteDb(':memory:');
  await migrateSqliteToLatest(db);
  const store = new DeliveryStore(db);
  const activity: string[] = [];
  const service = createDeliveryService({
    store,
    senders,
    audit: {
      record: input => {
        activity.push(`${input.tool_name}: ${input.description}`);
        return Promise.resolve();
      },
    },
    logger: winston.createLogger({ silent: true }),
    now: () => new Date(AT),
  });
  const deliver = (level: 'nudge' | 'call') =>
    service.deliver({
      ...OWNER,
      kind: 'nudge',
      level,
      text: 'Your 3pm clashes.',
      reason: 'Two things at once.',
      link: null,
    });
  return { service, deliver, activity };
}

describe('the delivery service', () => {
  it('names the channel that failed, and says where to see the item instead', async () => {
    const t = await setup([
      sender({ channel: 'web_push', outcome: 'sent', throws: true }),
      sender({ channel: 'sms', outcome: 'sent', throws: true }),
    ]);
    const delivery = await t.deliver('nudge');
    expect(delivery.attempts.map(attempt => attempt.detail)).toEqual([
      null,
      'The push notice could not be sent. Open the app to see it in your feed.',
      'The text could not be sent. Open the app to see it in your feed.',
    ]);
  });

  it('falls back through the channels a sender names when its own attempt did not go out, after writing that attempt', async () => {
    const t = await setup([
      sender({ channel: 'web_push', outcome: 'sent' }),
      sender({ channel: 'sms', outcome: 'sent' }),
      sender({ channel: 'call', outcome: 'skipped', fallsBackTo: ['sms', 'web_push'] }),
    ]);
    const delivery = await t.deliver('call');
    expect(delivery.attempts.map(attempt => [attempt.channel, attempt.outcome])).toEqual([
      ['in_app', 'sent'],
      ['call', 'skipped'],
      ['web_push', 'sent'],
      ['sms', 'sent'],
    ]);
    expect(t.activity.map(line => line.split(':')[0])).toEqual([
      'delivery.created',
      'delivery.call',
      'delivery.web_push',
      'delivery.sms',
    ]);
  });

  it('does not fall back when the sender’s attempt went out, or when it had nothing to do', async () => {
    const rang = await setup([
      sender({ channel: 'web_push', outcome: 'sent' }),
      sender({ channel: 'call', outcome: 'sent', fallsBackTo: ['web_push'] }),
    ]);
    expect((await rang.deliver('call')).attempts.map(attempt => attempt.channel)).toEqual(['in_app', 'call']);
    const nudge = await setup([
      sender({ channel: 'web_push', outcome: 'sent' }),
      sender({ channel: 'call', outcome: 'skipped', fallsBackTo: ['web_push'] }),
    ]);
    expect((await nudge.deliver('nudge')).attempts.map(attempt => attempt.channel)).toEqual(['in_app', 'web_push']);
  });
});

const ONCE_OWNER = { tenant_id: 't1', created_by: 'alice' };
const ONCE_AT = new Date('2026-11-05T15:00:00.000Z');
const INPUT = {
  ...ONCE_OWNER,
  id: 'event-delivery-1',
  kind: 'nudge' as const,
  level: 'nudge' as const,
  text: 'The model wrote this.',
  reason: 'Two events overlap.',
  link: null,
  created_at: ONCE_AT,
};

async function setupOnce() {
  const db = createSqliteDb(':memory:');
  await migrateSqliteToLatest(db);
  const store = new DeliveryStore(db);
  const sent: string[] = [];
  const sender: DeliveryChannelSender = {
    channel: 'web_push',
    send: ({ delivery, test }) => {
      sent.push(test ? `test: ${delivery.text}` : delivery.text);
      return Promise.resolve([
        { channel: 'web_push', outcome: 'sent', detail: null, target: 'phone', attempted_at: ONCE_AT.toISOString() },
      ]);
    },
  };
  const service = createDeliveryService({
    store,
    senders: [sender],
    audit: { record: () => Promise.resolve() },
    logger: winston.createLogger({ silent: true }),
    now: () => ONCE_AT,
  });
  return { store, service, sent };
}

describe('deliverOnce', () => {
  it('sends a delivery once, and a second call with the same id sends nothing', async () => {
    const { store, service, sent } = await setupOnce();
    const first = await service.deliverOnce(INPUT);
    const second = await service.deliverOnce({ ...INPUT, text: 'Other words.' });
    expect(second).toEqual(first);
    expect(sent).toEqual(['The model wrote this.']);
    expect((await store.list({ ...ONCE_OWNER, limit: 10 })).deliveries).toHaveLength(1);
    expect(first.attempts.map(attempt => attempt.channel)).toEqual(['in_app', 'web_push']);
  });

  it('sends again when the delivery was made but none of its sends were written down', async () => {
    const { store, service, sent } = await setupOnce();
    await store.createOnce(INPUT);
    const delivery = await service.deliverOnce(INPUT);
    expect(sent).toHaveLength(1);
    expect(delivery.attempts.map(attempt => attempt.channel)).toEqual(['in_app', 'web_push']);
    await service.deliverOnce(INPUT);
    expect(sent).toHaveLength(1);
  });
});

describe('a Try it test', () => {
  it('tries only the tested channel and tells its sender the delivery is a test', async () => {
    const { service, sent } = await setupOnce();
    const input = {
      ...OWNER,
      kind: INPUT.kind,
      level: INPUT.level,
      text: INPUT.text,
      reason: INPUT.reason,
      link: null,
    };
    await service.deliver({ ...input, test: 'web_push' });
    await service.deliver({ ...input, test: 'in_app' });
    await service.deliver(input);
    expect(sent).toEqual(['test: The model wrote this.', 'The model wrote this.']);
  });
});

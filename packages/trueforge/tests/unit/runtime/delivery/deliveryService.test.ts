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
  it('names the channel that failed, and says the item is still in the feed', async () => {
    const t = await setup([
      sender({ channel: 'web_push', outcome: 'sent', throws: true }),
      sender({ channel: 'sms', outcome: 'sent', throws: true }),
    ]);
    const delivery = await t.deliver('nudge');
    expect(delivery.attempts.map(attempt => attempt.detail)).toEqual([
      null,
      'The push notice could not be sent. It is still in your feed.',
      'The text could not be sent. It is still in your feed.',
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

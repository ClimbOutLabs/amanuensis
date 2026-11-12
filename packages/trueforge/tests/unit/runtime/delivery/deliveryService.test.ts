import winston from 'winston';

import { DeliveryStore } from '../../../../src/db/deliveryStore';
import { migrateSqliteToLatest } from '../../../../src/db/migrateSqlite';
import { createSqliteDb } from '../../../../src/db/sqlite/client';
import type { DeliveryChannelSender } from '../../../../src/runtime/delivery/deliveryChannel';
import { createDeliveryService } from '../../../../src/runtime/delivery/deliveryService';

const OWNER = { tenant_id: 't1', created_by: 'alice' };
const AT = new Date('2026-11-05T15:00:00.000Z');
const INPUT = {
  ...OWNER,
  id: 'event-delivery-1',
  kind: 'nudge' as const,
  level: 'nudge' as const,
  text: 'The model wrote this.',
  reason: 'Two events overlap.',
  link: null,
  created_at: AT,
};

async function setup() {
  const db = createSqliteDb(':memory:');
  await migrateSqliteToLatest(db);
  const store = new DeliveryStore(db);
  const sent: string[] = [];
  const sender: DeliveryChannelSender = {
    channel: 'web_push',
    send: ({ delivery }) => {
      sent.push(delivery.text);
      return Promise.resolve([
        { channel: 'web_push', outcome: 'sent', detail: null, target: 'phone', attempted_at: AT.toISOString() },
      ]);
    },
  };
  const service = createDeliveryService({
    store,
    senders: [sender],
    audit: { record: () => Promise.resolve() },
    logger: winston.createLogger({ silent: true }),
    now: () => AT,
  });
  return { store, service, sent };
}

describe('deliverOnce', () => {
  it('sends a delivery once, and a second call with the same id sends nothing', async () => {
    const { store, service, sent } = await setup();
    const first = await service.deliverOnce(INPUT);
    const second = await service.deliverOnce({ ...INPUT, text: 'Other words.' });
    expect(second).toEqual(first);
    expect(sent).toEqual(['The model wrote this.']);
    expect((await store.list({ ...OWNER, limit: 10 })).deliveries).toHaveLength(1);
    expect(first.attempts.map(attempt => attempt.channel)).toEqual(['in_app', 'web_push']);
  });

  it('sends again when the delivery was made but none of its sends were written down', async () => {
    const { store, service, sent } = await setup();
    await store.createOnce(INPUT);
    const delivery = await service.deliverOnce(INPUT);
    expect(sent).toHaveLength(1);
    expect(delivery.attempts.map(attempt => attempt.channel)).toEqual(['in_app', 'web_push']);
    await service.deliverOnce(INPUT);
    expect(sent).toHaveLength(1);
  });
});

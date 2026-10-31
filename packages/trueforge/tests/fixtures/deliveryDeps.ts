import type { AuditLogWriter } from '@truefoundry/trueforge-core/core';
import type { Kysely } from 'kysely';
import winston from 'winston';

import { DeliveryStore, type DeliveryDatabase } from '../../src/db/deliveryStore';
import { PushSubscriptionStore, type PushSubscriptionDatabase } from '../../src/db/pushSubscriptionStore';
import { createDeliveryService } from '../../src/runtime/delivery/deliveryService';

/** The feed's stores and service over a test database, with no push channel and an activity log that drops writes. */
export function deliveryDeps(
  db: Kysely<DeliveryDatabase & PushSubscriptionDatabase>,
  audit: AuditLogWriter = { record: () => Promise.resolve() },
) {
  const deliveryStore = new DeliveryStore(db);
  return {
    deliveryStore,
    pushSubscriptionStore: new PushSubscriptionStore(db),
    deliveryService: createDeliveryService({
      store: deliveryStore,
      senders: [],
      audit,
      logger: winston.createLogger({ silent: true }),
    }),
    webPushPublicKey: undefined,
  };
}

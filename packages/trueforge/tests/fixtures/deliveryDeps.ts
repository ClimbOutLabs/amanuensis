import type { AuditLogWriter } from '@truefoundry/trueforge-core/core';
import type { Kysely } from 'kysely';
import winston from 'winston';

import { DeliveryStore, type DeliveryDatabase } from '../../src/db/deliveryStore';
import { PushSubscriptionStore, type PushSubscriptionDatabase } from '../../src/db/pushSubscriptionStore';
import { TelegramStore, type TelegramDatabase } from '../../src/db/telegramStore';
import { createDeliveryService } from '../../src/runtime/delivery/deliveryService';
import { createTelegramSendQueue } from '../../src/runtime/telegram/telegramSendQueue';
import { createTelegramService } from '../../src/runtime/telegram/telegramService';

/** The feed's stores and service over a test database, with no push channel and an activity log that drops writes. */
export function deliveryDeps(
  db: Kysely<DeliveryDatabase & PushSubscriptionDatabase & TelegramDatabase>,
  audit: AuditLogWriter = { record: () => Promise.resolve() },
) {
  const deliveryStore = new DeliveryStore(db);
  const telegramStore = new TelegramStore(db);
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
    telegramStore,
    telegramService: createTelegramService({ store: telegramStore, publicBaseUrl: 'http://localhost' }),
    telegramQueue: createTelegramSendQueue({ gapMs: 0 }),
  };
}

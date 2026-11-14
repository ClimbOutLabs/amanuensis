import type { AuditLogWriter } from '@truefoundry/trueforge-core/core';
import type { Kysely } from 'kysely';
import winston from 'winston';

import { DeliveryStore, type DeliveryDatabase } from '../../src/db/deliveryStore';
import { NoticingStore, type NoticingDatabase } from '../../src/db/noticingStore';
import { PushSubscriptionStore, type PushSubscriptionDatabase } from '../../src/db/pushSubscriptionStore';
import { ReachSettingsStore, type ReachSettingsDatabase } from '../../src/db/reachSettingsStore';
import { TelegramStore, type TelegramDatabase } from '../../src/db/telegramStore';
import { TextContactStore, type TextContactDatabase } from '../../src/db/textContactStore';
import { createDeliveryService } from '../../src/runtime/delivery/deliveryService';
import { NO_PHONE_CHANNELS } from '../../src/runtime/noticing/reachChannels';
import { createReminderReach } from '../../src/runtime/noticing/reminderReach';
import { createTelegramSendQueue } from '../../src/runtime/telegram/telegramSendQueue';
import { createTelegramService } from '../../src/runtime/telegram/telegramService';
import { createTextNumberService } from '../../src/runtime/texts/textNumber';

/**
 * The feed's stores and service over a test database, with no push channel and an activity log that drops writes,
 * plus Reach me stores, a noticing service that finds no one, and reminders that follow the quiet defaults.
 */
export function deliveryDeps(
  db: Kysely<
    DeliveryDatabase &
      PushSubscriptionDatabase &
      ReachSettingsDatabase &
      NoticingDatabase &
      TextContactDatabase &
      TelegramDatabase
  >,
  audit: AuditLogWriter = { record: () => Promise.resolve() },
) {
  const deliveryStore = new DeliveryStore(db);
  const reachSettingsStore = new ReachSettingsStore(db);
  const textContactStore = new TextContactStore(db);
  const noticingStore = new NoticingStore(db);
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
    reachSettingsStore,
    noticingStore,
    noticingService: { run: () => Promise.resolve({ owners: 0, raised: 0 }) },
    reminderReach: createReminderReach({
      reachSettings: reachSettingsStore,
      store: noticingStore,
      history: deliveryStore,
      channels: () => NO_PHONE_CHANNELS,
      logger: winston.createLogger({ silent: true }),
    }),
    reachChannels: () => NO_PHONE_CHANNELS,
    isInstanceOwner: () => false,
    textContactStore,
    textNumbers: createTextNumberService({
      store: textContactStore,
      reachSettings: reachSettingsStore,
      personalization: { getProfile: () => Promise.resolve(undefined) },
      provider: undefined,
      audit,
      logger: winston.createLogger({ silent: true }),
      codeKey: 'test-code-key',
    }),
    phoneCalls: { place: () => Promise.reject(new Error('No calls in this test.')) },
    webPushPublicKey: undefined,
    telegramStore,
    telegramService: createTelegramService({ store: telegramStore, publicBaseUrl: 'http://localhost' }),
    telegramQueue: createTelegramSendQueue({ gapMs: 0 }),
  };
}

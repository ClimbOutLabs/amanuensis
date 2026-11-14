import winston from 'winston';

import { DeliveryStore } from '../../src/db/deliveryStore';
import { migrateSqliteToLatest } from '../../src/db/migrateSqlite';
import type { PersonOwner } from '../../src/db/personOwner';
import { ReachSettingsStore } from '../../src/db/reachSettingsStore';
import { createSqliteDb } from '../../src/db/sqlite/client';
import { SqlitePersonalizationStore } from '../../src/db/sqlite/personalization-store/SqlitePersonalizationStore';
import { TextContactStore } from '../../src/db/textContactStore';
import { createDeliveryService } from '../../src/runtime/delivery/deliveryService';
import type { SmsProvider, SmsSendResult } from '../../src/runtime/texts/smsProvider';
import { createSmsSender } from '../../src/runtime/texts/smsSender';
import { createTextNumberService } from '../../src/runtime/texts/textNumber';
import { defaultReachSettings } from '../../src/schemas/reach';
import type { TextMode } from '../../src/schemas/textMessages';

export const ALICE = { tenant_id: 'default', created_by: 'alice' };
export const PHONE = '+15550111';

export interface SentText {
  to: string;
  body: string;
}

/**
 * Stores, a fake text provider, a text number service and a delivery service with the text channel, all over one test
 * database. The clock only moves when a test moves it.
 */
export async function textsHarness({
  assistantName = 'Mannie',
  provider = true,
  codeKey = 'test-code-key',
  maxTextsPerDay = 500,
  smsProvider: wire,
}: {
  assistantName?: string | null;
  provider?: boolean;
  codeKey?: string;
  maxTextsPerDay?: number;
  /** A provider to send through instead of the recording one, such as the real one over a fake Twilio. */
  smsProvider?: SmsProvider;
} = {}) {
  const db = createSqliteDb(':memory:');
  await migrateSqliteToLatest(db);
  const logger = winston.createLogger({ silent: true });
  const contacts = new TextContactStore(db);
  const reachSettings = new ReachSettingsStore(db);
  const deliveryStore = new DeliveryStore(db);
  const sent: SentText[] = [];
  const next: { result: SmsSendResult } = { result: { outcome: 'sent' } };
  const smsProvider: SmsProvider | undefined =
    wire ??
    (provider
      ? {
          send: input => {
            sent.push(input);
            return Promise.resolve(next.result);
          },
        }
      : undefined);
  const activity: { tool_name: string; description: string; created_by: string }[] = [];
  const audit = {
    record: (input: { tool_name: string; description: string; created_by: string }) => {
      activity.push({ tool_name: input.tool_name, description: input.description, created_by: input.created_by });
      return Promise.resolve();
    },
  };
  const personalization = new SqlitePersonalizationStore(db);
  if (assistantName !== null) {
    await personalization.upsertProfile({
      ...ALICE,
      updated_by: 'alice',
      assistant_name: assistantName,
      assistant_identity: null,
      voice_guidance: null,
      user_name: 'Dana Reyes',
      address_as: 'Dana',
      user_profile: null,
      pinned_preferences: [],
      help_areas: [],
      learned_profile: null,
      learning_enabled: false,
    });
  }
  const clock = { now: new Date('2026-11-06T10:00:00.000Z') };
  const codes = ['111111', '222222', '333333', '444444', '555555'];
  const serviceWith = (overrides: { codeKey: string }) =>
    createTextNumberService({
      store: contacts,
      reachSettings,
      personalization,
      provider: smsProvider,
      audit,
      logger,
      codeKey: overrides.codeKey,
      now: () => clock.now,
      newCode: () => codes.shift() ?? '999999',
    });
  const numbers = serviceWith({ codeKey });
  const limits = { number_key: codeKey, max_texts_per_day: maxTextsPerDay };
  const deliveries = createDeliveryService({
    store: deliveryStore,
    senders: [
      createSmsSender({
        contacts,
        reachSettings,
        personalization,
        provider: smsProvider,
        limits,
        textNumbers: numbers,
        now: () => clock.now,
      }),
    ],
    audit,
    logger,
    now: () => clock.now,
  });

  /** A person whose number is confirmed, with texts switched on, the way the Settings page leaves them. */
  async function readyToText({
    mode = 'private',
    owner = ALICE,
    phone = PHONE,
  }: { mode?: TextMode; owner?: PersonOwner; phone?: string } = {}) {
    const code = { hash: 'seeded', salt: 'seeded', key_id: 'seeded', expires_at: '2026-11-06T09:10:00.000Z' };
    const at = new Date('2026-11-06T09:00:00.000Z');
    await contacts.startCode({ ...owner, phone, as: 'number', code, now: at });
    await contacts.confirmCode({ ...owner, code_hash: code.hash, now: at });
    await contacts.setMode({ ...owner, mode, now: at });
    const settings = defaultReachSettings('UTC');
    await reachSettings.put({ ...owner, settings: { ...settings, channels: { ...settings.channels, texts: true } } });
  }

  return {
    db,
    contacts,
    reachSettings,
    deliveryStore,
    numbers,
    limits,
    serviceWith,
    deliveries,
    sent,
    next,
    activity,
    clock,
    readyToText,
  };
}

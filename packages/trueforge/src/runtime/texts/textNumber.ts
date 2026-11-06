import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

import type { AuditLogWriter } from '@truefoundry/trueforge-core/core';
import type { Logger } from 'winston';

import type { IPersonalizationStore } from '../../db/personalizationStore';
import type { IReachSettingsStore } from '../../db/reachSettingsStore';
import type { ITextContactStore, TextContactOwner } from '../../db/textContactStore';
import { E164_PATTERN, type TextContact, type TextMode, type TextStatus } from '../../schemas/textMessages';
import { assistantNameFor } from './assistantName';
import type { SmsFailure, SmsProvider } from './smsProvider';
import { codeText, privateText } from './textWords';

export const CODE_TTL_MS = 10 * 60_000;
/** Tries at one code. The last one used up, the code is void and a new one must be asked for. */
export const MAX_CODE_ATTEMPTS = 5;
/** Codes sent in one hour for one person, whatever number they ask for, so the page cannot be used to text strangers. */
export const MAX_CODES_PER_HOUR = 3;
/** Codes sent to one number, whoever asks, so many people together cannot flood it either. */
export const MAX_CODES_PER_NUMBER_PER_HOUR = 3;
export const MAX_CODES_PER_NUMBER_PER_DAY = 10;
const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

/** The words Twilio treats as STOP in English, whatever the case. */
const OPT_OUT_WORDS = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT']);

export function isOptOutWord(body: string): boolean {
  return OPT_OUT_WORDS.has(body.trim().toUpperCase());
}

/** A number in international form from what the person typed, or undefined when it is not one. */
export function normalizePhoneNumber(raw: string): string | undefined {
  const cleaned = raw.replace(/[\s().-]/g, '');
  return E164_PATTERN.test(cleaned) ? cleaned : undefined;
}

/** Whether texts may go to this number: the person proved it, and it has not replied STOP. */
export function canText(contact: TextContact | undefined): contact is TextContact {
  return contact !== undefined && contact.confirmed_at !== null && contact.opted_out_at === null;
}

function pendingCode(contact: TextContact | undefined): { hash: string; salt: string } | undefined {
  const hash = contact?.code_hash;
  const salt = contact?.code_salt;
  if (typeof hash !== 'string' || typeof salt !== 'string') {
    return undefined;
  }
  return { hash, salt };
}

export type SendCodeResult =
  | { ok: true }
  | { ok: false; reason: 'bad_number' | 'not_set_up' }
  | { ok: false; reason: 'send_failed'; failure: SmsFailure }
  | { ok: false; reason: 'rate_limited'; retry_in_minutes: number };

export type ConfirmCodeResult =
  | { ok: true }
  | { ok: false; reason: 'no_code' | 'expired' | 'too_many' }
  | { ok: false; reason: 'wrong'; attempts_left: number };

export type TextModeResult = { ok: true } | { ok: false; reason: 'no_number' };

export interface TextNumberService {
  status(owner: TextContactOwner): Promise<TextStatus>;
  /**
   * Texts a one-time code to the number. Nothing else is ever sent to a number before it is confirmed. A new number
   * waits beside a confirmed one, which keeps getting texts until the new one is confirmed.
   */
  sendCode(input: { owner: TextContactOwner; phone: string }): Promise<SendCodeResult>;
  confirm(input: { owner: TextContactOwner; code: string }): Promise<ConfirmCodeResult>;
  setMode(input: { owner: TextContactOwner; mode: TextMode }): Promise<TextModeResult>;
  /** Forgets the number and switches texts off. Codes already sent stay counted. */
  remove(owner: TextContactOwner): Promise<void>;
  /** A STOP from this number: texts go off for everyone who has it, and Activity says so. Resolves to how many people. */
  stopNumber(phone: string): Promise<number>;
}

export function createTextNumberService({
  store,
  reachSettings,
  personalization,
  provider,
  audit,
  logger,
  codeKey,
  now = () => new Date(),
  newCode = () => String(randomInt(0, 1_000_000)).padStart(6, '0'),
}: {
  store: ITextContactStore;
  reachSettings: Pick<IReachSettingsStore, 'get' | 'put'>;
  personalization: Pick<IPersonalizationStore, 'getProfile'>;
  /** Undefined when this server has no text provider. */
  provider: SmsProvider | undefined;
  audit: AuditLogWriter;
  logger: Logger;
  /** A server secret that is never stored in the database, so a copy of the database cannot be used to find a code. */
  codeKey: string;
  now?: () => Date;
  /** Seam for tests. */
  newCode?: () => string;
}): TextNumberService {
  const hashCode = ({ code, salt, owner }: { code: string; salt: string; owner: TextContactOwner }): string =>
    createHmac('sha256', codeKey)
      .update(`${salt}\u0000${owner.tenant_id}\u0000${owner.created_by}\u0000${code}`)
      .digest('hex');

  /** A number in a limit's key, keyed so the count table never holds the number itself. */
  const numberKey = (phone: string): string =>
    createHmac('sha256', codeKey).update(`number\u0000${phone}`).digest('hex');

  async function textsOff(owner: TextContactOwner): Promise<void> {
    const settings = await reachSettings.get(owner);
    if (settings?.channels.texts === true) {
      await reachSettings.put({
        ...owner,
        settings: { ...settings, channels: { ...settings.channels, texts: false } },
      });
    }
  }

  async function record({
    owner,
    tool_name,
    description,
  }: {
    owner: TextContactOwner;
    tool_name: string;
    description: string;
  }) {
    try {
      await audit.record({
        ...owner,
        conversation_id: '',
        tier: 1,
        tool_name,
        description,
        outcome: 'logged',
        auto_deny_reason: null,
      });
    } catch (error) {
      // The activity log being unavailable never changes what happened to the number.
      logger.warn('Could not record a text change in the activity log', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Counts the send against the person, the number by the hour and the number by the day, each in one statement
   * before the provider is called, so neither parallel requests nor a failing provider get past a limit. A limit
   * already passed when a later one refuses stays spent.
   */
  async function claimSend({
    owner,
    phone,
    at,
  }: {
    owner: TextContactOwner;
    phone: string;
    at: Date;
  }): Promise<{ ok: true } | { ok: false; retry_in_minutes: number }> {
    await store.forgetCodeSends({ before: new Date(at.getTime() - DAY_MS) });
    const limits = [
      {
        key: `person:${JSON.stringify([owner.tenant_id, owner.created_by])}`,
        window_ms: HOUR_MS,
        max: MAX_CODES_PER_HOUR,
      },
      { key: `number-hour:${numberKey(phone)}`, window_ms: HOUR_MS, max: MAX_CODES_PER_NUMBER_PER_HOUR },
      { key: `number-day:${numberKey(phone)}`, window_ms: DAY_MS, max: MAX_CODES_PER_NUMBER_PER_DAY },
    ];
    for (const limit of limits) {
      const claim = await store.claimCodeSend({ ...limit, now: at });
      if (!claim.ok) {
        const waited = at.getTime() - new Date(claim.window_started_at).getTime();
        return { ok: false, retry_in_minutes: Math.max(1, Math.ceil((limit.window_ms - waited) / 60_000)) };
      }
    }
    return { ok: true };
  }

  return {
    async status(owner) {
      const [contact, name] = await Promise.all([store.get(owner), assistantNameFor({ personalization, owner })]);
      const private_preview = privateText({ name, kind: 'reminder' });
      if (contact === undefined) {
        return {
          phone: null,
          confirmed: false,
          mode: 'private',
          opted_out: false,
          pending_phone: null,
          code_pending: false,
          private_preview,
        };
      }
      const pending =
        contact.code_hash !== null &&
        contact.code_expires_at !== null &&
        new Date(contact.code_expires_at).getTime() > now().getTime() &&
        contact.code_attempts < MAX_CODE_ATTEMPTS;
      return {
        phone: contact.phone,
        confirmed: contact.confirmed_at !== null,
        mode: contact.mode,
        opted_out: contact.opted_out_at !== null,
        pending_phone: contact.pending_phone,
        code_pending: pending,
        private_preview,
      };
    },

    async sendCode({ owner, phone }) {
      if (provider === undefined) {
        return { ok: false, reason: 'not_set_up' };
      }
      const number = normalizePhoneNumber(phone);
      if (number === undefined) {
        return { ok: false, reason: 'bad_number' };
      }
      const at = now();
      const claim = await claimSend({ owner, phone: number, at });
      if (!claim.ok) {
        return { ok: false, reason: 'rate_limited', retry_in_minutes: claim.retry_in_minutes };
      }
      const code = newCode();
      const salt = randomBytes(16).toString('hex');
      const stored = {
        hash: hashCode({ code, salt, owner }),
        salt,
        expires_at: new Date(at.getTime() + CODE_TTL_MS).toISOString(),
      };
      const existing = await store.get(owner);
      // A confirmed number keeps getting texts while a new one is being confirmed.
      const beside =
        canText(existing) &&
        existing.phone !== number &&
        (await store.startCode({ ...owner, phone: number, as: 'new_number', code: stored, now: at }));
      if (!beside) {
        if (existing !== undefined && existing.phone !== number) {
          await textsOff(owner);
        }
        await store.startCode({ ...owner, phone: number, as: 'number', code: stored, now: at });
      }
      const result = await provider.send({ to: number, body: codeText(code) });
      if (result.outcome === 'failed') {
        await store.clearCode({ ...owner, code_hash: stored.hash, now: at });
        return { ok: false, reason: 'send_failed', failure: result.failure };
      }
      return { ok: true };
    },

    async confirm({ owner, code }) {
      const contact = await store.get(owner);
      const pending = pendingCode(contact);
      if (contact === undefined || pending === undefined) {
        return { ok: false, reason: 'no_code' };
      }
      const at = now();
      const forget = () => store.clearCode({ ...owner, code_hash: pending.hash, now: at });
      if (contact.code_expires_at === null || new Date(contact.code_expires_at).getTime() <= at.getTime()) {
        await forget();
        return { ok: false, reason: 'expired' };
      }
      const attempt = await store.countCodeAttempt(owner);
      if (attempt === undefined) {
        return { ok: false, reason: 'no_code' };
      }
      if (attempt > MAX_CODE_ATTEMPTS) {
        await forget();
        return { ok: false, reason: 'too_many' };
      }
      const given = Buffer.from(hashCode({ code: code.trim(), salt: pending.salt, owner }), 'hex');
      const wanted = Buffer.from(pending.hash, 'hex');
      if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) {
        if (attempt >= MAX_CODE_ATTEMPTS) {
          await forget();
          return { ok: false, reason: 'too_many' };
        }
        return { ok: false, reason: 'wrong', attempts_left: MAX_CODE_ATTEMPTS - attempt };
      }
      // Only while the code read above is still the pending one, so a STOP or a newer code in between is never undone.
      if (!(await store.confirmCode({ ...owner, code_hash: pending.hash, now: at }))) {
        return { ok: false, reason: 'no_code' };
      }
      await record({ owner, tool_name: 'delivery.sms_confirmed', description: 'You confirmed your number for texts.' });
      return { ok: true };
    },

    async setMode({ owner, mode }) {
      if (!(await store.setMode({ ...owner, mode, now: now() }))) {
        return { ok: false, reason: 'no_number' };
      }
      return { ok: true };
    },

    async remove(owner) {
      await textsOff(owner);
      if (await store.remove(owner)) {
        await record({
          owner,
          tool_name: 'delivery.sms_removed',
          description: 'You removed your number. Texts are off.',
        });
      }
    },

    async stopNumber(phone) {
      const { opted_out, pending_dropped } = await store.optOut({ phone, now: now() });
      // Reach settings are per person, so each one is switched off on its own. A number is rarely shared by many.
      for (const owner of opted_out) {
        await textsOff(owner);
        await record({
          owner,
          tool_name: 'delivery.sms_stop',
          description:
            'You replied STOP, so texts are off. To use them again, reply START from that phone and confirm the number again in Settings.',
        });
      }
      for (const owner of pending_dropped) {
        await record({
          owner,
          tool_name: 'delivery.sms_stop',
          description:
            'The new number replied STOP, so it was not added. Texts still go to the number you confirmed before.',
        });
      }
      return opted_out.length + pending_dropped.length;
    },
  };
}

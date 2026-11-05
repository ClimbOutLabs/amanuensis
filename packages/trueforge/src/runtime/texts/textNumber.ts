import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

import type { AuditLogWriter } from '@truefoundry/trueforge-core/core';
import type { Logger } from 'winston';

import type { IPersonalizationStore } from '../../db/personalizationStore';
import type { IReachSettingsStore } from '../../db/reachSettingsStore';
import type { ITextContactStore, TextContactOwner } from '../../db/textContactStore';
import { E164_PATTERN, type TextContact, type TextMode, type TextStatus } from '../../schemas/textMessages';
import { assistantNameFor } from './assistantName';
import type { SmsProvider } from './smsProvider';

export const CODE_TTL_MS = 10 * 60_000;
/** Tries at one code. The last one used up, the code is void and a new one must be asked for. */
export const MAX_CODE_ATTEMPTS = 5;
/** Codes sent in one hour for one person, whatever number they ask for, so the page cannot be used to text strangers. */
export const MAX_CODES_PER_HOUR = 3;
const HOUR_MS = 60 * 60_000;

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
  | { ok: false; reason: 'bad_number' | 'not_set_up' | 'send_failed' }
  | { ok: false; reason: 'rate_limited'; retry_in_minutes: number };

export type ConfirmCodeResult =
  | { ok: true }
  | { ok: false; reason: 'no_code' | 'expired' | 'too_many' }
  | { ok: false; reason: 'wrong'; attempts_left: number };

export type TextModeResult = { ok: true } | { ok: false; reason: 'no_number' };

export interface TextNumberService {
  status(owner: TextContactOwner): Promise<TextStatus>;
  /** Texts a one-time code to the number. Nothing else is ever sent to a number before it is confirmed. */
  sendCode(input: { owner: TextContactOwner; phone: string }): Promise<SendCodeResult>;
  confirm(input: { owner: TextContactOwner; code: string }): Promise<ConfirmCodeResult>;
  setMode(input: { owner: TextContactOwner; mode: TextMode }): Promise<TextModeResult>;
  /** Forgets the number and switches texts off. */
  remove(owner: TextContactOwner): Promise<void>;
  /** A STOP from this number: texts go off for everyone who has it, and Activity says so. Resolves to how many people. */
  stopNumber(phone: string): Promise<number>;
}

function hashCode({ code, salt, owner }: { code: string; salt: string; owner: TextContactOwner }): string {
  return createHmac('sha256', salt).update(`${owner.tenant_id}\u0000${owner.created_by}\u0000${code}`).digest('hex');
}

function blankContact({ phone, mode }: { phone: string; mode: TextMode }): TextContact {
  return {
    phone,
    mode,
    confirmed_at: null,
    opted_out_at: null,
    code_hash: null,
    code_salt: null,
    code_expires_at: null,
    code_attempts: 0,
    send_window_started_at: null,
    sends_in_window: 0,
  };
}

export function createTextNumberService({
  store,
  reachSettings,
  personalization,
  provider,
  audit,
  logger,
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
  now?: () => Date;
  /** Seam for tests. */
  newCode?: () => string;
}): TextNumberService {
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

  return {
    async status(owner) {
      const contact = await store.get(owner);
      if (contact === undefined) {
        return { phone: null, confirmed: false, mode: 'private', opted_out: false, code_pending: false };
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
        code_pending: pending,
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
      const existing = await store.get(owner);
      const windowStart = existing?.send_window_started_at ?? null;
      const inWindow = windowStart !== null && at.getTime() - new Date(windowStart).getTime() < HOUR_MS;
      if (inWindow && (existing?.sends_in_window ?? 0) >= MAX_CODES_PER_HOUR) {
        const waited = at.getTime() - new Date(windowStart).getTime();
        return {
          ok: false,
          reason: 'rate_limited',
          retry_in_minutes: Math.max(1, Math.ceil((HOUR_MS - waited) / 60_000)),
        };
      }
      const code = newCode();
      const salt = randomBytes(16).toString('hex');
      const sameNumber = existing?.phone === number;
      const base: TextContact = {
        ...(existing ?? blankContact({ phone: number, mode: 'private' })),
        phone: number,
        // A different number starts unconfirmed. The same one keeps what it earned, so a fresh code never switches it off.
        confirmed_at: sameNumber ? existing.confirmed_at : null,
        opted_out_at: sameNumber ? existing.opted_out_at : null,
      };
      const pending: TextContact = {
        ...base,
        code_hash: hashCode({ code, salt, owner }),
        code_salt: salt,
        code_expires_at: new Date(at.getTime() + CODE_TTL_MS).toISOString(),
        code_attempts: 0,
        send_window_started_at: inWindow ? windowStart : at.toISOString(),
        sends_in_window: inWindow ? (existing?.sends_in_window ?? 0) + 1 : 1,
      };
      if (!sameNumber) {
        await textsOff(owner);
      }
      // The send is counted before it is tried, so a failing provider cannot be used to get past the limit.
      await store.put({ ...owner, contact: pending, now: at });
      const name = await assistantNameFor({ personalization, owner });
      const result = await provider.send({
        to: number,
        body: `${name}: your confirmation code is ${code}. It works for 10 minutes. If you did not ask for it, ignore this text.`,
      });
      if (result.outcome === 'failed') {
        await store.put({
          ...owner,
          contact: { ...pending, code_hash: null, code_salt: null, code_expires_at: null },
          now: at,
        });
        return { ok: false, reason: 'send_failed' };
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
      const forget = async (): Promise<void> => {
        await store.put({
          ...owner,
          contact: { ...contact, code_hash: null, code_salt: null, code_expires_at: null, code_attempts: 0 },
          now: at,
        });
      };
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
      await store.put({
        ...owner,
        contact: {
          ...contact,
          confirmed_at: at.toISOString(),
          opted_out_at: null,
          code_hash: null,
          code_salt: null,
          code_expires_at: null,
          code_attempts: 0,
        },
        now: at,
      });
      await record({ owner, tool_name: 'delivery.sms_confirmed', description: 'You confirmed your number for texts.' });
      return { ok: true };
    },

    async setMode({ owner, mode }) {
      const contact = await store.get(owner);
      if (contact === undefined) {
        return { ok: false, reason: 'no_number' };
      }
      await store.put({ ...owner, contact: { ...contact, mode }, now: now() });
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
      const at = now();
      const owners = await store.listByPhone(phone);
      for (const { contact, ...owner } of owners) {
        await store.put({
          ...owner,
          contact: {
            ...contact,
            confirmed_at: null,
            opted_out_at: at.toISOString(),
            code_hash: null,
            code_salt: null,
            code_expires_at: null,
            code_attempts: 0,
          },
          now: at,
        });
        await textsOff(owner);
        await record({
          owner,
          tool_name: 'delivery.sms_stop',
          description:
            'You replied STOP, so texts are off. To use them again, reply START from that phone and confirm the number again in Settings.',
        });
      }
      return owners.length;
    },
  };
}

import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

import type { AuditLogWriter } from '@truefoundry/trueforge-core/core';
import type { Logger } from 'winston';

import type { IPersonalizationStore } from '../../db/personalizationStore';
import type { PersonOwner } from '../../db/personOwner';
import type { IReachSettingsStore } from '../../db/reachSettingsStore';
import type { ITextContactStore } from '../../db/textContactStore';
import {
  E164_PATTERN,
  TEXT_WORDS_MAX,
  type TextContact,
  type TextMode,
  type TextStatus,
} from '../../schemas/textMessages';
import { textAssistantName } from './assistantName';
import { customWordProblem, foldWord } from './knownWords';
import type { SmsFailure, SmsProvider } from './smsProvider';
import { claimTextLimits, codeTextLimits } from './textLimits';
import { codeText, privateText } from './textWords';

export const CODE_TTL_MS = 10 * 60_000;
/** Tries at one code. The last one used up, the code is void and a new one must be asked for. */
export const MAX_CODE_ATTEMPTS = 5;
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

type SendCodeResult =
  | { ok: true }
  | { ok: false; reason: 'bad_number' | 'not_set_up' }
  | { ok: false; reason: 'send_failed'; failure: SmsFailure }
  | { ok: false; reason: 'rate_limited'; retry_in_minutes: number };

type ConfirmCodeResult =
  | { ok: true }
  | { ok: false; reason: 'no_code' | 'expired' | 'too_many' }
  | { ok: false; reason: 'wrong'; attempts_left: number };

type TextModeResult = { ok: true } | { ok: false; reason: 'no_number' };

type AddWordResult = { ok: true } | { ok: false; reason: 'refused'; problem: string } | { ok: false; reason: 'full' };

export interface TextNumberService {
  status(owner: PersonOwner): Promise<TextStatus>;
  /**
   * Texts a one-time code to the number. Nothing else is ever sent to a number before it is confirmed. A new number
   * waits beside a confirmed one, which keeps getting texts until the new one is confirmed.
   */
  sendCode(input: { owner: PersonOwner; phone: string }): Promise<SendCodeResult>;
  confirm(input: { owner: PersonOwner; code: string }): Promise<ConfirmCodeResult>;
  setMode(input: { owner: PersonOwner; mode: TextMode }): Promise<TextModeResult>;
  /** Lets Full texts carry a word that is not on the common list. Adding a word already there changes nothing. */
  addWord(input: { owner: PersonOwner; word: string }): Promise<AddWordResult>;
  removeWord(input: { owner: PersonOwner; word: string }): Promise<void>;
  /** Forgets the number and switches texts off. Codes already sent stay counted. */
  remove(owner: PersonOwner): Promise<void>;
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
  /**
   * A server secret that is never stored in the database, so a copy of the database cannot be used to find a code.
   * Undefined when this server has no text provider.
   */
  codeKey: string | undefined;
  now?: () => Date;
  /** Seam for tests. */
  newCode?: () => string;
}): TextNumberService {
  const hashCode = ({ key, code, salt, owner }: { key: string; code: string; salt: string; owner: PersonOwner }) =>
    createHmac('sha256', key)
      .update(`${salt}\u0000${owner.tenant_id}\u0000${owner.created_by}\u0000${code}`)
      .digest('hex');

  /** Names the key without giving it away, so a code hashed before the key changed reads as no code. */
  const keyId =
    codeKey === undefined ? undefined : createHmac('sha256', codeKey).update('key id').digest('hex').slice(0, 12);

  /** The pending code, only while it was hashed with this server's key. */
  function pendingCode(contact: TextContact | undefined): { hash: string; salt: string; key: string } | undefined {
    const hash = contact?.code_hash;
    const salt = contact?.code_salt;
    if (codeKey === undefined || typeof hash !== 'string' || typeof salt !== 'string') {
      return undefined;
    }
    return contact?.code_key_id === keyId ? { hash, salt, key: codeKey } : undefined;
  }

  async function textsOff(owner: PersonOwner): Promise<void> {
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
    owner: PersonOwner;
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
      const [contact, name, words] = await Promise.all([
        store.get(owner),
        textAssistantName({ personalization, owner }),
        store.listWords(owner),
      ]);
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
          words,
        };
      }
      const pending =
        pendingCode(contact) !== undefined &&
        contact.code_expires_at !== null &&
        new Date(contact.code_expires_at).getTime() > now().getTime() &&
        contact.code_attempts < MAX_CODE_ATTEMPTS;
      return {
        phone: contact.phone,
        // A number that replied STOP keeps its confirmation for the limits, but must be confirmed again to get texts.
        confirmed: canText(contact),
        mode: contact.mode,
        opted_out: contact.opted_out_at !== null,
        pending_phone: contact.pending_phone,
        code_pending: pending,
        private_preview,
        words,
      };
    },

    async sendCode({ owner, phone }) {
      if (provider === undefined || codeKey === undefined || keyId === undefined) {
        return { ok: false, reason: 'not_set_up' };
      }
      const number = normalizePhoneNumber(phone);
      if (number === undefined) {
        return { ok: false, reason: 'bad_number' };
      }
      const at = now();
      const existing = await store.get(owner);
      const claim = await claimTextLimits({
        store,
        limits: codeTextLimits({
          secret: codeKey,
          owner,
          phone: number,
          confirmed_by_owner: existing?.phone === number && existing.confirmed_at !== null,
        }),
        at,
      });
      if (!claim.ok) {
        return { ok: false, reason: 'rate_limited', retry_in_minutes: claim.retry_in_minutes };
      }
      const code = newCode();
      const salt = randomBytes(16).toString('hex');
      const stored = {
        hash: hashCode({ key: codeKey, code, salt, owner }),
        salt,
        key_id: keyId,
        expires_at: new Date(at.getTime() + CODE_TTL_MS).toISOString(),
      };
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
      const given = Buffer.from(hashCode({ key: pending.key, code: code.trim(), salt: pending.salt, owner }), 'hex');
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

    async addWord({ owner, word }) {
      const problem = customWordProblem(word);
      if (problem !== undefined) {
        return { ok: false, reason: 'refused', problem };
      }
      const added = await store.addWord({ ...owner, word: foldWord(word), max: TEXT_WORDS_MAX, now: now() });
      return added === 'full' ? { ok: false, reason: 'full' } : { ok: true };
    },

    async removeWord({ owner, word }) {
      await store.removeWord({ ...owner, word: foldWord(word) });
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
      const { opted_out, unconfirmed_dropped, pending_dropped } = await store.optOut({ phone, now: now() });
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
      for (const owner of unconfirmed_dropped) {
        await record({
          owner,
          tool_name: 'delivery.sms_new_number_stopped',
          description:
            'The number you were confirming replied STOP, so it was removed. To use texts, enter a number again in Settings.',
        });
      }
      for (const owner of pending_dropped) {
        await record({
          owner,
          tool_name: 'delivery.sms_new_number_stopped',
          description:
            'The new number replied STOP, so it was not added. Texts still go to the number you confirmed before.',
        });
      }
      return opted_out.length + unconfirmed_dropped.length + pending_dropped.length;
    },
  };
}

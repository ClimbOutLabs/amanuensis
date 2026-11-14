import { hkdfSync, randomInt } from 'node:crypto';

import type { IGlobalSettingsStore } from '../db/globalSettingsStore';
import { checkMasterKey } from './keyCheck';
import {
  MASTER_KEY_BYTES,
  SecretDecryptError,
  SecretKeyMismatchError,
  decryptSecret,
  encryptSecret,
  type SecretContext,
} from './secretCipher';

/** Global setting holding this database's copy of the master key, locked with the recovery key. */
export const RECOVERY_COPY_SETTING = 'secrets_recovery_copy';

const GROUPS = 8;
const GROUP_DIGITS = 6;
const RECOVERY_COPY_CONTEXT: SecretContext = {
  table: 'global_settings',
  primary_key: RECOVERY_COPY_SETTING,
  field: 'value',
};

export class RecoveryKeyFormatError extends Error {
  constructor() {
    super('A recovery key is 48 digits, in 8 groups of 6. Check each group and try again.');
    this.name = 'RecoveryKeyFormatError';
  }
}

export class RecoveryKeyRejectedError extends Error {
  constructor(options?: ErrorOptions) {
    super('That recovery key does not unlock this Aman. Check each group of digits and try again.', options);
    this.name = 'RecoveryKeyRejectedError';
  }
}

export class RecoveryCopyMissingError extends Error {
  constructor() {
    super('This database has no recovery copy of its key. Restore a backup made after setup, then try again.');
    this.name = 'RecoveryCopyMissingError';
  }
}

/** A new recovery key: 48 random digits (about 159 bits), shown as 8 groups of 6. */
export function generateRecoveryKey(): string {
  const groups: string[] = [];
  for (let i = 0; i < GROUPS; i += 1) {
    groups.push(String(randomInt(0, 10 ** GROUP_DIGITS)).padStart(GROUP_DIGITS, '0'));
  }
  return groups.join('-');
}

/** Accepts the key as typed, with spaces or dashes anywhere, and returns its canonical form. */
export function normalizeRecoveryKey(input: string): string {
  const digits = input.replace(/[\s-]/g, '');
  if (!/^\d{48}$/.test(digits)) {
    throw new RecoveryKeyFormatError();
  }
  const groups: string[] = [];
  for (let i = 0; i < GROUPS; i += 1) {
    groups.push(digits.slice(i * GROUP_DIGITS, (i + 1) * GROUP_DIGITS));
  }
  return groups.join('-');
}

/**
 * Saves (or replaces) this database's recovery copy of the master key. Replacing it with a new
 * recovery key makes the old one stop working. Refuses a master key this database wasn't set up with.
 */
export async function saveRecoveryCopy({
  settings,
  masterKey,
  recoveryKey,
}: {
  settings: IGlobalSettingsStore;
  masterKey: Buffer;
  recoveryKey: string;
}): Promise<void> {
  if ((await checkMasterKey({ settings, key: masterKey })) !== 'match') {
    throw new Error('Set up secrets for this database before saving a recovery copy');
  }
  const value = encryptSecret({
    key: wrappingKey(recoveryKey),
    plaintext: masterKey.toString('base64'),
    context: RECOVERY_COPY_CONTEXT,
  });
  await settings.setSetting({ key: RECOVERY_COPY_SETTING, value });
}

/** The master key, recovered from this database's copy with the recovery key alone. */
export async function recoverMasterKey({
  settings,
  recoveryKey,
}: {
  settings: IGlobalSettingsStore;
  recoveryKey: string;
}): Promise<Buffer> {
  const wrapping = wrappingKey(recoveryKey);
  const copy = await settings.getSetting({ key: RECOVERY_COPY_SETTING });
  if (copy === undefined) {
    throw new RecoveryCopyMissingError();
  }
  let masterKey: Buffer;
  try {
    masterKey = Buffer.from(
      decryptSecret({ key: wrapping, value: copy.value, context: RECOVERY_COPY_CONTEXT }),
      'base64',
    );
  } catch (caught) {
    if (caught instanceof SecretKeyMismatchError || caught instanceof SecretDecryptError) {
      throw new RecoveryKeyRejectedError({ cause: caught });
    }
    throw caught;
  }
  if (masterKey.length !== MASTER_KEY_BYTES || (await checkMasterKey({ settings, key: masterKey })) !== 'match') {
    throw new RecoveryKeyRejectedError();
  }
  return masterKey;
}

/**
 * Limits recovery key attempts so a locked Aman can't be tried at machine speed.
 * In memory: a restart resets it, which costs an attacker a restart per few guesses.
 */
export class RecoveryAttemptLimiter {
  readonly #max: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  #failures: number[] = [];

  constructor({
    max = 5,
    windowMs = 15 * 60_000,
    now = Date.now,
  }: { max?: number; windowMs?: number; now?: () => number } = {}) {
    this.#max = max;
    this.#windowMs = windowMs;
    this.#now = now;
  }

  /** Milliseconds until another attempt is allowed, or 0 when one is allowed now. */
  waitMs(): number {
    const now = this.#now();
    this.#failures = this.#failures.filter(at => now - at < this.#windowMs);
    const oldest = this.#failures[0];
    return this.#failures.length < this.#max || oldest === undefined ? 0 : oldest + this.#windowMs - now;
  }

  recordFailure(): void {
    this.#failures.push(this.#now());
  }

  reset(): void {
    this.#failures = [];
  }
}

function wrappingKey(recoveryKey: string): Buffer {
  // The recovery key carries ~159 random bits, so a fast KDF is enough; no password stretching needed.
  const ikm = Buffer.from(normalizeRecoveryKey(recoveryKey), 'utf8');
  return Buffer.from(hkdfSync('sha256', ikm, 'aman recovery key v1', 'wrap master key', MASTER_KEY_BYTES));
}

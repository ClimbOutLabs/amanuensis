import { extractErrorLogFields } from '@truefoundry/trueforge-core/core';
import { randomInt, timingSafeEqual } from 'node:crypto';
import type { Logger } from 'winston';

import { hashTerminalKey, mintTerminalKey } from '../auth/terminalKey';
import type { ITerminalKeyStore } from '../db/terminalKeyStore';
import { newId } from '../utils/id';

/** How long a pairing code stays good: long enough to walk to the web app, short enough to be worthless later. */
export const TERMINAL_PAIRING_TTL_MS = 5 * 60_000;

/**
 * Failed completions a pairing survives. The waiting terminal always sends the code
 * it was given, so a completion with a wrong code is a guess; five guesses end the
 * pairing, and the person starts again.
 */
export const TERMINAL_PAIRING_MAX_FAILED_COMPLETIONS = 5;

/** The person who confirmed a pairing, in the shape their sign-in gave. */
export interface TerminalPairingOwner {
  tenant_id: string;
  subject_id: string;
  subject_type: string;
  subject_display_name: string;
}

interface PendingPairing {
  pairing_id: string;
  /** Hash of the pairing code; the code itself is never kept after it is handed to the terminal. */
  code_hash: string;
  device_name: string;
  expires_at_ms: number;
  state: 'pending' | 'confirmed';
  /**
   * The minted terminal key, held in memory only between the confirm and the one
   * completion that claims it. Never stored, never logged, gone once claimed.
   */
  terminal_key: string | undefined;
  /** The stored row the confirm minted, and the person it belongs to; set only once confirmed. */
  terminal_key_id: string | undefined;
  owner: TerminalPairingOwner | undefined;
  /** Completions that named this pairing with a wrong code; enough of them end the pairing. */
  failed_completions: number;
  /** Whether the pairing start already has its audit entry; when not, the confirm writes it. */
  start_audit_recorded: boolean;
}

/** Letters and digits a person can read off a terminal without mixing any up: no 0, O, 1, I or L. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;

function mintPairingCode(): string {
  let raw = '';
  for (let index = 0; index < CODE_LENGTH; index += 1) {
    raw += CODE_ALPHABET.charAt(randomInt(CODE_ALPHABET.length));
  }
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

/** Codes compare without the dash and without case, so a code typed back by hand still matches. */
export function normalizePairingCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function codeHashesEqual(providedHash: string, storedHash: string): boolean {
  const provided = Buffer.from(providedHash, 'utf8');
  const stored = Buffer.from(storedHash, 'utf8');
  return provided.length === stored.length && timingSafeEqual(provided, stored);
}

export type TerminalPairingCompletion =
  { status: 'waiting' } | { status: 'paired'; terminal_key: string; device_name: string };

/**
 * Pairings in flight, held in memory like the sign-in limiter's state: a pairing is
 * worth minutes, so a restart simply ends it and the person starts again. The minted
 * key crosses from the confirm to the waiting terminal through this memory and
 * nowhere else; only its hash ever reaches the database.
 */
export class TerminalPairingService {
  readonly #terminalKeyStore: ITerminalKeyStore;
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #logger: Logger | undefined;
  readonly #byId = new Map<string, PendingPairing>();
  readonly #pairingIdByCodeHash = new Map<string, string>();

  constructor(deps: { terminalKeyStore: ITerminalKeyStore; now?: () => number; ttlMs?: number; logger?: Logger }) {
    this.#terminalKeyStore = deps.terminalKeyStore;
    this.#now = deps.now ?? Date.now;
    this.#ttlMs = deps.ttlMs ?? TERMINAL_PAIRING_TTL_MS;
    this.#logger = deps.logger;
  }

  /** Begins a pairing for a device name the terminal gave. The code is returned once, here. */
  async start(input: { device_name: string }): Promise<{ pairing_id: string; code: string; expires_at: string }> {
    await this.#pruneExpired();
    let code = mintPairingCode();
    let codeHash = hashTerminalKey(normalizePairingCode(code));
    while (this.#pairingIdByCodeHash.has(codeHash)) {
      code = mintPairingCode();
      codeHash = hashTerminalKey(normalizePairingCode(code));
    }
    const pairing_id = newId();
    const expires_at_ms = this.#now() + this.#ttlMs;
    this.#byId.set(pairing_id, {
      pairing_id,
      code_hash: codeHash,
      device_name: input.device_name,
      expires_at_ms,
      state: 'pending',
      terminal_key: undefined,
      terminal_key_id: undefined,
      owner: undefined,
      failed_completions: 0,
      start_audit_recorded: false,
    });
    this.#pairingIdByCodeHash.set(codeHash, pairing_id);
    return { pairing_id, code, expires_at: new Date(expires_at_ms).toISOString() };
  }

  /** Records whether the start of this pairing already has its audit entry. */
  noteStartAuditRecorded(pairing_id: string, recorded: boolean): void {
    const pairing = this.#byId.get(pairing_id);
    if (pairing !== undefined) {
      pairing.start_audit_recorded = recorded;
    }
  }

  /**
   * Confirms a code for the signed-in person: mints the terminal key, stores its hash,
   * and holds the key itself for the waiting terminal. Returns undefined when the code
   * is unknown, expired or already used, so the three read the same from outside.
   */
  async confirm(input: {
    code: string;
    owner: TerminalPairingOwner;
  }): Promise<{ device_name: string; paired_at: string; start_audit_recorded: boolean } | undefined> {
    const codeHash = hashTerminalKey(normalizePairingCode(input.code));
    const pairingId = this.#pairingIdByCodeHash.get(codeHash);
    const pairing = pairingId === undefined ? undefined : await this.#livePairing(pairingId);
    if (pairing?.state !== 'pending' || !codeHashesEqual(codeHash, pairing.code_hash)) {
      return undefined;
    }
    // Claim the pairing before the store write, in the same turn of the event loop:
    // a second confirm racing this one sees the pairing confirmed and is refused, so
    // a race mints exactly one key instead of two, one of them orphaned.
    pairing.state = 'confirmed';
    const terminalKey = mintTerminalKey();
    const keyId = newId();
    const paired_at = new Date(this.#now()).toISOString();
    pairing.terminal_key_id = keyId;
    pairing.owner = input.owner;
    try {
      await this.#terminalKeyStore.create({
        id: keyId,
        tenant_id: input.owner.tenant_id,
        subject_id: input.owner.subject_id,
        subject_type: input.owner.subject_type,
        subject_display_name: input.owner.subject_display_name,
        device_name: pairing.device_name,
        key_hash: hashTerminalKey(terminalKey),
        created_at: paired_at,
        last_used_at: paired_at,
        revoked_at: null,
      });
    } catch (createError) {
      // Nothing was stored, so the pairing was never confirmed: hand it back to
      // pending, so the person can use the code again once the store is back.
      pairing.state = 'pending';
      pairing.terminal_key_id = undefined;
      pairing.owner = undefined;
      throw createError;
    }
    pairing.terminal_key = terminalKey;
    return {
      device_name: pairing.device_name,
      paired_at,
      start_audit_recorded: pairing.start_audit_recorded,
    };
  }

  /**
   * The device name of the pairing a code names, while that pairing is still
   * waiting: the confirm page shows it before the person approves, so they can see
   * which terminal they are about to pair. Returns undefined when the code is
   * unknown, expired or already used, so the three read the same from outside,
   * exactly as at confirm. Looking a pairing up never changes it.
   */
  async lookup(input: { code: string }): Promise<{ device_name: string } | undefined> {
    const codeHash = hashTerminalKey(normalizePairingCode(input.code));
    const pairingId = this.#pairingIdByCodeHash.get(codeHash);
    const pairing = pairingId === undefined ? undefined : await this.#livePairing(pairingId);
    if (pairing?.state !== 'pending' || !codeHashesEqual(codeHash, pairing.code_hash)) {
      return undefined;
    }
    return { device_name: pairing.device_name };
  }

  /**
   * What the waiting terminal polls: still waiting, the key (exactly once, after which
   * the pairing is gone), or undefined when the pairing id and code name nothing live.
   * A completion with a wrong code counts against the pairing, and enough of them end
   * it: without a budget, this route would be a free oracle for guessing codes.
   */
  async complete(input: { pairing_id: string; code: string }): Promise<TerminalPairingCompletion | undefined> {
    const pairing = await this.#livePairing(input.pairing_id);
    if (pairing === undefined) {
      return undefined;
    }
    const codeHash = hashTerminalKey(normalizePairingCode(input.code));
    if (!codeHashesEqual(codeHash, pairing.code_hash)) {
      pairing.failed_completions += 1;
      if (pairing.failed_completions >= TERMINAL_PAIRING_MAX_FAILED_COMPLETIONS) {
        this.#drop(pairing);
        await this.#revokeUnclaimedKey(pairing);
      }
      return undefined;
    }
    if (pairing.state === 'pending' || pairing.terminal_key === undefined) {
      return { status: 'waiting' };
    }
    const terminal_key = pairing.terminal_key;
    // Claimed: the key belongs to the terminal now, so the lapse rule must not revoke it.
    pairing.terminal_key = undefined;
    this.#drop(pairing);
    return { status: 'paired', terminal_key, device_name: pairing.device_name };
  }

  /** The pairing when it exists and has not expired; an expired pairing is dropped and reads as gone. */
  async #livePairing(pairing_id: string): Promise<PendingPairing | undefined> {
    const pairing = this.#byId.get(pairing_id);
    if (pairing === undefined) {
      return undefined;
    }
    if (this.#now() > pairing.expires_at_ms) {
      this.#drop(pairing);
      await this.#revokeUnclaimedKey(pairing);
      return undefined;
    }
    return pairing;
  }

  #drop(pairing: PendingPairing): void {
    this.#byId.delete(pairing.pairing_id);
    this.#pairingIdByCodeHash.delete(pairing.code_hash);
  }

  async #pruneExpired(): Promise<void> {
    for (const pairing of [...this.#byId.values()]) {
      if (this.#now() > pairing.expires_at_ms) {
        this.#drop(pairing);
        await this.#revokeUnclaimedKey(pairing);
      }
    }
  }

  /**
   * Revokes the stored key of a confirmed pairing that is dropped before its terminal
   * ever collected the key. Nobody holds that key, so leaving its row live would
   * leave a working key in the database that no one is watching. Best effort: a
   * failure is logged, and the row stays in the Settings list, where the person can
   * still revoke it by hand.
   */
  async #revokeUnclaimedKey(pairing: PendingPairing): Promise<void> {
    if (pairing.state !== 'confirmed' || pairing.terminal_key === undefined) {
      return;
    }
    const keyId = pairing.terminal_key_id;
    const owner = pairing.owner;
    if (keyId === undefined || owner === undefined) {
      return;
    }
    try {
      await this.#terminalKeyStore.revoke({
        tenant_id: owner.tenant_id,
        subject_id: owner.subject_id,
        id: keyId,
        revoked_at: new Date(this.#now()).toISOString(),
      });
    } catch (revokeError) {
      this.#logger?.error('Failed to revoke the key of a lapsed terminal pairing', {
        terminal_key_id: keyId,
        ...extractErrorLogFields(revokeError),
      });
    }
  }
}

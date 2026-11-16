import { extractErrorLogFields } from '@truefoundry/trueforge-core/core';
import { createHash, randomBytes } from 'node:crypto';
import type { Logger } from 'winston';

import type { ITerminalKeyStore } from '../db/terminalKeyStore';
import type { RequestContext } from './identity';
import { readBearerToken } from './token';

/**
 * Terminal keys: the long-lived credential a paired terminal (the `aman-tui` app)
 * presents as a Bearer token. A key is random, so its SHA-256 hash is safe to store
 * and compare; the key itself is never stored, logged or shown again after pairing.
 */
export const TERMINAL_KEY_PREFIX = 'aman_tk_';

/** A freshly minted terminal key: the prefix plus 32 random bytes. Handed to the terminal exactly once, at pairing. */
export function mintTerminalKey(): string {
  return `${TERMINAL_KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
}

/** True when a token has the terminal key shape. Session tokens are JWTs and never carry this prefix. */
export function isTerminalKey(token: string): boolean {
  return token.startsWith(TERMINAL_KEY_PREFIX) && token.length > TERMINAL_KEY_PREFIX.length;
}

/** The only form of a terminal key the server keeps: its SHA-256 hash, hex encoded. */
export function hashTerminalKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

/**
 * The request context for a presented terminal key, or undefined when the key is
 * unknown or revoked. A live key is marked used, so its last-used time follows it.
 * That write is bookkeeping: when it fails, the failure is logged and the request
 * still signs in, because a stale last-used time must never lock a terminal out.
 * The context carries no roles: a terminal key is not an admin, and the auth layer
 * limits it to the chat scope (see terminalScope.ts).
 *
 * `passwordChangedAt` is the local sign-in's last password change, when the caller
 * knows it. A key claimed before that moment is refused even when its row carries
 * no revocation: a pairing confirmed just before the change can have its key row
 * land after the change's revocation has run, and the claim time on the row is
 * what proves the key belongs to the time before the change.
 */
export async function terminalKeyRequestContext(params: {
  store: ITerminalKeyStore;
  bearerToken: string;
  logger?: Logger;
  passwordChangedAt?: string;
}): Promise<RequestContext | undefined> {
  const record = await params.store.findByKeyHash(hashTerminalKey(params.bearerToken));
  if (record?.revoked_at !== null) {
    return undefined;
  }
  if (params.passwordChangedAt !== undefined && record.created_at <= params.passwordChangedAt) {
    return undefined;
  }
  try {
    await params.store.markUsed({ id: record.id, used_at: new Date().toISOString() });
  } catch (markUsedError) {
    params.logger?.error('Failed to record a terminal key use', {
      terminal_key_id: record.id,
      ...extractErrorLogFields(markUsedError),
    });
  }
  return {
    tenant_id: record.tenant_id,
    subject: {
      id: record.subject_id,
      type: record.subject_type,
      display_name: record.subject_display_name,
    },
    roles: [],
    user_credential: params.bearerToken,
    terminal_key_id: record.id,
  };
}

/**
 * When the request carries a terminal key as its Bearer token, resolve it against the
 * store: a context for a live key, and undefined for an unknown or revoked one. Returns
 * undefined without touching the store when the Bearer token is not a terminal key, so
 * session tokens follow their usual path.
 */
export async function resolveTerminalKeyContext(params: {
  store: ITerminalKeyStore | undefined;
  context: Parameters<typeof readBearerToken>[0];
  logger?: Logger;
  passwordChangedAt?: string;
}): Promise<RequestContext | undefined> {
  if (params.store === undefined) {
    return undefined;
  }
  const bearer = readBearerToken(params.context);
  if (bearer === undefined || !isTerminalKey(bearer)) {
    return undefined;
  }
  return terminalKeyRequestContext({
    store: params.store,
    bearerToken: bearer,
    ...(params.logger === undefined ? {} : { logger: params.logger }),
    ...(params.passwordChangedAt === undefined ? {} : { passwordChangedAt: params.passwordChangedAt }),
  });
}

/** True when the request carries a terminal-shaped Bearer token, live or not. */
export function carriesTerminalKey(context: Parameters<typeof readBearerToken>[0]): boolean {
  const bearer = readBearerToken(context);
  return bearer !== undefined && isTerminalKey(bearer);
}

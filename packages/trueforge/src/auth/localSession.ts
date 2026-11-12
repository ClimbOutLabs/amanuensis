import { randomBytes } from 'node:crypto';

import { jwtVerify, SignJWT } from 'jose';

import type { IGlobalSettingsStore } from '../db/globalSettingsStore';
import type { LocalUserRecord } from '../db/localUserStore';

/** Where the session signing secret lives in the global settings: made once, never shown anywhere. */
const SECRET_SETTING_KEY = 'local_sign_in_secret';
const TOKEN_ISSUER = 'amanuensis-local';
const TOKEN_AUDIENCE = 'amanuensis';

/** Same life as the sign-in cookie the OIDC callback sets. */
export const LOCAL_SESSION_MAX_AGE_SECONDS = 24 * 60 * 60;

function decodeSecret(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64url'));
}

/**
 * The key local session tokens are signed with. It is made on first use and kept in the
 * instance's own settings, so it survives restarts and never leaves the machine. Two
 * processes racing to make it settle on the one stored value.
 */
export async function getOrCreateLocalSessionSecret(store: IGlobalSettingsStore): Promise<Uint8Array> {
  const existing = await store.getSetting({ key: SECRET_SETTING_KEY });
  if (existing !== undefined && existing.value !== '') {
    return decodeSecret(existing.value);
  }
  const made = randomBytes(32).toString('base64url');
  const won = await store.compareAndSetSetting({ key: SECRET_SETTING_KEY, expected: null, value: made });
  if (won) {
    return decodeSecret(made);
  }
  const stored = await store.getSetting({ key: SECRET_SETTING_KEY });
  if (stored === undefined || stored.value === '') {
    throw new Error('The local sign-in secret could not be stored. Restart Aman and try again.');
  }
  return decodeSecret(stored.value);
}

/** A signed session token for the local user, carrying the session version it was issued under. */
export async function issueLocalSessionToken(params: { user: LocalUserRecord; secret: Uint8Array }): Promise<string> {
  return new SignJWT({ email: params.user.email, ver: params.user.session_version })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(params.user.id)
    .setIssuer(TOKEN_ISSUER)
    .setAudience(TOKEN_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${String(LOCAL_SESSION_MAX_AGE_SECONDS)}s`)
    .sign(params.secret);
}

export interface LocalSessionClaims {
  user_id: string;
  email: string;
  session_version: number;
}

/** The claims of a local session token, or undefined when it does not check out. Never throws. */
export async function verifyLocalSessionToken(params: {
  token: string;
  secret: Uint8Array;
}): Promise<LocalSessionClaims | undefined> {
  try {
    const { payload } = await jwtVerify(params.token, params.secret, {
      issuer: TOKEN_ISSUER,
      audience: TOKEN_AUDIENCE,
      algorithms: ['HS256'],
    });
    const email = payload['email'];
    const version = payload['ver'];
    if (payload.sub === undefined || typeof email !== 'string' || typeof version !== 'number') {
      return undefined;
    }
    return { user_id: payload.sub, email, session_version: version };
  } catch {
    return undefined;
  }
}

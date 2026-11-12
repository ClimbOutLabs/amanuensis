import { LocalUserAlreadyExistsError, type ILocalUserStore, type LocalUserRecord } from '../db/localUserStore';
import { newId } from '../utils/id';
import { hashPasswordValue, PASSWORD_MAX_BYTES, passwordTooLongMessage, verifyPasswordValue } from './passwordHash';

/** The one refusal for a failed sign-in: the same words whether the email or the password was wrong. */
export const LOCAL_WRONG_CREDENTIALS_MESSAGE = 'That email or password is not right';
export const LOCAL_PASSWORDS_DO_NOT_MATCH_MESSAGE = 'The two passwords do not match. Type them again.';
export const LOCAL_EMAIL_SHAPE_MESSAGE = 'That does not look like an email address. Check it and try again.';
export const LOCAL_PASSWORD_TOO_SHORT_MESSAGE = 'Use at least 8 characters for the password.';
export const LOCAL_SIGN_IN_EXISTS_MESSAGE = 'Your sign-in is already set up. Sign in instead.';
export const LOCAL_NO_SIGN_IN_MESSAGE = 'No sign-in is set up yet. Create yours first.';

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;

/** Addresses are stored and matched lower-cased, the way the sign-in service matches them. */
export function normalizeLocalEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/** The message for an email that cannot be the sign-in address, or undefined when it can. */
export function localEmailProblem(email: string): string | undefined {
  return EMAIL_SHAPE.test(email) ? undefined : LOCAL_EMAIL_SHAPE_MESSAGE;
}

/** The message for a password that cannot be used, or undefined when it can. */
export function localPasswordProblem(password: string): string | undefined {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return LOCAL_PASSWORD_TOO_SHORT_MESSAGE;
  }
  if (Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_BYTES) {
    return passwordTooLongMessage();
  }
  return undefined;
}

/**
 * A stand-in hash so a sign-in attempt for an address that is not the owner's costs the
 * same bcrypt check as a wrong password; the answer and its timing stay the same shape.
 */
let dummyHash: Promise<string> | undefined;
function standInHash(): Promise<string> {
  dummyHash ??= hashPasswordValue('a password nobody has');
  return dummyHash;
}

export type CreateLocalUserResult = { ok: true; user: LocalUserRecord } | { ok: false; message: string };

/** First run only: stores the one local user. The store refuses when one already exists. */
export async function createLocalUser(params: {
  store: ILocalUserStore;
  email: string;
  password: string;
}): Promise<CreateLocalUserResult> {
  const email = normalizeLocalEmail(params.email);
  const emailProblem = localEmailProblem(email);
  if (emailProblem !== undefined) {
    return { ok: false, message: emailProblem };
  }
  const passwordProblem = localPasswordProblem(params.password);
  if (passwordProblem !== undefined) {
    return { ok: false, message: passwordProblem };
  }
  const now = new Date().toISOString();
  const user: LocalUserRecord = {
    id: newId(),
    email,
    password_hash: await hashPasswordValue(params.password),
    session_version: 1,
    created_at: now,
    updated_at: now,
  };
  try {
    await params.store.createUser(user);
  } catch (error) {
    if (error instanceof LocalUserAlreadyExistsError) {
      return { ok: false, message: LOCAL_SIGN_IN_EXISTS_MESSAGE };
    }
    throw error;
  }
  return { ok: true, user };
}

/**
 * The local user when the address and password check out, else undefined. A wrong address
 * runs the same bcrypt check against a stand-in hash, and nothing about the attempt is
 * logged here beyond what the caller's rate limiter keeps.
 */
export async function verifyLocalSignIn(params: {
  store: ILocalUserStore;
  email: string;
  password: string;
}): Promise<LocalUserRecord | undefined> {
  const user = await params.store.getUser();
  const email = normalizeLocalEmail(params.email);
  if (user?.email !== email) {
    await verifyPasswordValue(params.password, await standInHash());
    return undefined;
  }
  const matches = await verifyPasswordValue(params.password, user.password_hash);
  return matches ? user : undefined;
}

export type ChangeLocalPasswordResult = { ok: true; user: LocalUserRecord } | { ok: false; message: string };

/**
 * Change the password from a live session: the current password must check out first.
 * The store raises the session version with the hash, so every other session ends;
 * the returned record carries the new version so this session can be re-issued.
 */
export async function changeLocalUserPassword(params: {
  store: ILocalUserStore;
  user_id: string;
  current_password: string;
  new_password: string;
}): Promise<ChangeLocalPasswordResult> {
  const user = await params.store.getUser();
  if (user?.id !== params.user_id) {
    return { ok: false, message: LOCAL_WRONG_CREDENTIALS_MESSAGE };
  }
  const currentMatches = await verifyPasswordValue(params.current_password, user.password_hash);
  if (!currentMatches) {
    return { ok: false, message: LOCAL_WRONG_CREDENTIALS_MESSAGE };
  }
  const passwordProblem = localPasswordProblem(params.new_password);
  if (passwordProblem !== undefined) {
    return { ok: false, message: passwordProblem };
  }
  const replaced = await params.store.replacePasswordHash({
    password_hash: await hashPasswordValue(params.new_password),
    updated_at: new Date().toISOString(),
  });
  if (!replaced) {
    return { ok: false, message: LOCAL_WRONG_CREDENTIALS_MESSAGE };
  }
  const updated = await params.store.getUser();
  if (updated === undefined) {
    return { ok: false, message: LOCAL_WRONG_CREDENTIALS_MESSAGE };
  }
  return { ok: true, user: updated };
}

export type ResetLocalPasswordResult = { ok: true } | { ok: false; message: string };

/**
 * The terminal reset: replaces the hash with no current-password check, for the person
 * standing at the machine. The store raises the session version with the hash, so every
 * live session ends and the person signs in with the new password.
 */
export async function resetLocalUserPassword(params: {
  store: ILocalUserStore;
  new_password: string;
}): Promise<ResetLocalPasswordResult> {
  const user = await params.store.getUser();
  if (user === undefined) {
    return { ok: false, message: LOCAL_NO_SIGN_IN_MESSAGE };
  }
  const passwordProblem = localPasswordProblem(params.new_password);
  if (passwordProblem !== undefined) {
    return { ok: false, message: passwordProblem };
  }
  const replaced = await params.store.replacePasswordHash({
    password_hash: await hashPasswordValue(params.new_password),
    updated_at: new Date().toISOString(),
  });
  return replaced ? { ok: true } : { ok: false, message: LOCAL_NO_SIGN_IN_MESSAGE };
}

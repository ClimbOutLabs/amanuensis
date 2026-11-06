/**
 * The one person who signs in with a password Aman keeps itself (local sign-in,
 * `TRUEFORGE_AUTH_MODE=local`). There is never more than one row: creating a second
 * one is refused, so an instance has exactly one owner.
 */
export interface LocalUserRecord {
  id: string;
  email: string;
  password_hash: string;
  /** Goes up on every password change or reset; session tokens carry the value they were issued under. */
  session_version: number;
  created_at: string;
  updated_at: string;
}

/** One row of `local_user`. Times are text on SQLite and timestamptz on Postgres. */
export interface LocalUserTable {
  id: string;
  email: string;
  password_hash: string;
  session_version: number;
  created_at: string | Date;
  updated_at: string | Date;
}

/** Thrown when a create is attempted while the one local user already exists. */
export class LocalUserAlreadyExistsError extends Error {
  constructor() {
    super('This instance already has its sign-in. Only one person can be set up.');
    this.name = 'LocalUserAlreadyExistsError';
  }
}

/** Row to record: Postgres hands timestamps back as Date, SQLite as the stored text. */
export function localUserRecordFromRow(row: LocalUserTable): LocalUserRecord {
  return {
    id: row.id,
    email: row.email,
    password_hash: row.password_hash,
    session_version: row.session_version,
    created_at: typeof row.created_at === 'string' ? row.created_at : row.created_at.toISOString(),
    updated_at: typeof row.updated_at === 'string' ? row.updated_at : row.updated_at.toISOString(),
  };
}

export interface ILocalUserStore {
  /** The one local user, or undefined while nobody has signed up yet. */
  getUser(): Promise<LocalUserRecord | undefined>;
  /**
   * Stores the first local user. Refuses with {@link LocalUserAlreadyExistsError} when one
   * already exists; the check and the insert happen together so two first-run creates
   * racing each other cannot both land.
   */
  createUser(record: LocalUserRecord): Promise<void>;
  /**
   * Replaces the password hash and raises `session_version` in the same write, so every
   * session issued under the old password stops working. Returns false when there is no user.
   */
  replacePasswordHash(input: { password_hash: string; updated_at: string }): Promise<boolean>;
}

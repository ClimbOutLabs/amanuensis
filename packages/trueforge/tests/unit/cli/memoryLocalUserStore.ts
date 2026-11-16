import {
  LocalUserAlreadyExistsError,
  type ILocalUserStore,
  type LocalUserRecord,
} from '../../../src/db/localUserStore';

/** The local user store in memory, refusing a second user like the database stores do. */
export class MemoryLocalUserStore implements ILocalUserStore {
  #user: LocalUserRecord | undefined;

  getUser(): Promise<LocalUserRecord | undefined> {
    return Promise.resolve(this.#user);
  }

  createUser(record: LocalUserRecord): Promise<void> {
    if (this.#user !== undefined) {
      return Promise.reject(new LocalUserAlreadyExistsError());
    }
    this.#user = record;
    return Promise.resolve();
  }

  replacePasswordHash(input: { password_hash: string; updated_at: string }): Promise<boolean> {
    if (this.#user === undefined) {
      return Promise.resolve(false);
    }
    this.#user = {
      ...this.#user,
      password_hash: input.password_hash,
      session_version: this.#user.session_version + 1,
      updated_at: input.updated_at,
    };
    return Promise.resolve(true);
  }
}

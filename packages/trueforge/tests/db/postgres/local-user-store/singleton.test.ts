import { sql } from 'kysely';

import { LocalUserAlreadyExistsError, type LocalUserRecord } from '../../../../src/db/localUserStore';
import { isUniqueViolation } from '../../../../src/db/postgres/client';
import { PostgresLocalUserStore } from '../../../../src/db/postgres/local-user-store/PostgresLocalUserStore';
import { createPostgresTestDatabase, type PostgresTestDatabase } from '../testDatabase';

const describePg = process.env['PG_STORE_TESTS_ENABLED'] === '1' ? describe : describe.skip;

const NOW = '2026-11-06T00:00:00.000Z';

function record(overrides: Partial<LocalUserRecord> = {}): LocalUserRecord {
  return {
    id: 'user-1',
    email: 'owner@example.com',
    password_hash: 'hash-one',
    session_version: 1,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

/**
 * The one-owner rule on Postgres must hold at the database, not by timing: these cases
 * put a second create in the exact window the old check-then-insert left open.
 */
describePg('LocalUserStore on Postgres (one owner by construction)', () => {
  let env: PostgresTestDatabase | undefined;

  beforeAll(async () => {
    env = await createPostgresTestDatabase();
    if (env === undefined) {
      throw new Error('Postgres test environment unavailable despite globalSetup probe');
    }
  }, 120_000);

  afterAll(async () => {
    await env?.teardown();
  });

  beforeEach(async () => {
    if (env !== undefined) {
      await sql`TRUNCATE TABLE local_user CASCADE`.execute(env.db);
    }
  });

  it('refuses a second create whose check ran before the first create committed', async () => {
    if (env === undefined) {
      throw new Error('Postgres test environment not initialized');
    }
    const store = new PostgresLocalUserStore(env.db);
    const first = record();
    const second = record({ id: 'user-2', email: 'other@example.com' });

    // The first create inserts its row and then waits, still uncommitted, so the
    // second create's own check sees an empty table. Only the unique singleton
    // index can stop the second insert.
    let markInserted: () => void = () => undefined;
    const inserted = new Promise<void>(resolve => {
      markInserted = resolve;
    });
    let releaseFirst: () => void = () => undefined;
    const holdFirst = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });
    const firstCreate = env.db.transaction().execute(async trx => {
      await trx
        .insertInto('local_user')
        .values({
          id: first.id,
          email: first.email,
          password_hash: first.password_hash,
          session_version: first.session_version,
          created_at: first.created_at,
          updated_at: first.updated_at,
        })
        .execute();
      markInserted();
      await holdFirst;
    });
    await inserted;

    const secondCreate = store.createUser(second);
    void secondCreate.catch(() => undefined);

    // Wait until the second create is truly blocked on the first one's uncommitted
    // row; that is the proof its check already ran and saw nothing.
    let blocked = false;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const { rows } = await sql<{ waiting: number }>`
        SELECT COUNT(*)::int AS waiting
        FROM pg_stat_activity
        WHERE pid <> pg_backend_pid() AND wait_event_type = 'Lock'
      `.execute(env.db);
      if (rows[0] !== undefined && rows[0].waiting > 0) {
        blocked = true;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    releaseFirst();

    await expect(firstCreate).resolves.toBeUndefined();
    expect(blocked).toBe(true);
    await expect(secondCreate).rejects.toBeInstanceOf(LocalUserAlreadyExistsError);
    await expect(store.getUser()).resolves.toEqual(first);
  }, 60_000);

  it('refuses a second row inserted directly, past the store check', async () => {
    if (env === undefined) {
      throw new Error('Postgres test environment not initialized');
    }
    const store = new PostgresLocalUserStore(env.db);
    await store.createUser(record());

    const second = record({ id: 'user-2', email: 'other@example.com' });
    const error: unknown = await env.db
      .insertInto('local_user')
      .values({
        id: second.id,
        email: second.email,
        password_hash: second.password_hash,
        session_version: second.session_version,
        created_at: second.created_at,
        updated_at: second.updated_at,
      })
      .execute()
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expect(isUniqueViolation(error)).toBe(true);
    await expect(store.getUser()).resolves.toEqual(record());
  });
});

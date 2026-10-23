/**
 * `20261023_000001_session_title_source` added `session.title_source`. Chat titles no longer use it, but
 * installed databases have already run it, so the migration stays and the column must not get in
 * the way of starting up or of reading, creating and renaming chats.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { sql, type Kysely } from 'kysely';

import { makeAgentSpec, makeCreateTurnInput } from '../../../../../trueforge-core/tests/agent-session/testHelpers';
import { migrateSqliteToLatest } from '../../../../src/db/migrateSqlite';
import { createSqliteDb } from '../../../../src/db/sqlite/client';
import { SqliteSessionStore } from '../../../../src/db/sqlite/session-store/SqliteSessionStore';
import type { Database } from '../../../../src/db/sqlite/types';

const TENANT = 'tenant-title-source';
const THIS_MIGRATION = '20261023_000001_session_title_source';

async function seedChat(store: SqliteSessionStore, sessionId: string): Promise<void> {
  await store.createSession({
    tenant_id: TENANT,
    session_id: sessionId,
    created_by_subject: { subject_id: 'alice', subject_type: 'user', subject_display_name: 'alice' },
    agent: { type: 'inline', spec: makeAgentSpec() },
    custom: null,
    metadata: {},
    external_id: null,
    source: null,
  });
}

async function titleSources(db: Kysely<Database>): Promise<Record<string, string | null>> {
  const { rows } = await sql<{ session_id: string; title_source: string | null }>`
    SELECT session_id, title_source FROM session ORDER BY session_id
  `.execute(db);
  return Object.fromEntries(rows.map(row => [row.session_id, row.title_source]));
}

describe('session title_source column after chat auto-titles were removed', () => {
  let tempDir: string;
  let db: Kysely<Database>;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-sqlite-title-source-'));
    db = createSqliteDb(path.join(tempDir, 'store.sqlite'));
  }, 120_000);

  afterEach(async () => {
    await db.destroy();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('starts again on a database that already ran the migration and holds titles written with a source', async () => {
    await migrateSqliteToLatest(db);
    const store = new SqliteSessionStore(db);
    await seedChat(store, 'chat-auto');
    await seedChat(store, 'chat-first-message');
    await seedChat(store, 'chat-person');
    // What the earlier version left behind: a title and who set it.
    for (const [sessionId, source] of [
      ['chat-auto', 'auto'],
      ['chat-first-message', 'first_message'],
      ['chat-person', 'person'],
    ]) {
      await sql`UPDATE session SET title = ${`Title of ${sessionId}`}, title_source = ${source}
        WHERE session_id = ${sessionId}`.execute(db);
    }

    // Startup runs the migrations again; the recorded migration must still be found.
    await expect(migrateSqliteToLatest(db)).resolves.toBeUndefined();
    const { rows: applied } = await sql<{ name: string }>`
      SELECT name FROM kysely_migration WHERE name = ${THIS_MIGRATION}
    `.execute(db);
    expect(applied).toEqual([{ name: THIS_MIGRATION }]);

    for (const sessionId of ['chat-auto', 'chat-first-message', 'chat-person']) {
      const session = await store.getSession({ tenant_id: TENANT, session_id: sessionId });
      expect(session?.title).toBe(`Title of ${sessionId}`);
    }

    await store.updateSession({
      tenant_id: TENANT,
      session_id: 'chat-first-message',
      agent: undefined,
      title: 'Renamed by me',
      metadata: undefined,
    });
    expect((await store.getSession({ tenant_id: TENANT, session_id: 'chat-first-message' }))?.title).toBe(
      'Renamed by me',
    );
    // Old values stay as they were; nothing writes the column any more.
    expect(await titleSources(db)).toEqual({
      'chat-auto': 'auto',
      'chat-first-message': 'first_message',
      'chat-person': 'person',
    });
  });

  it('titles a new chat from its first message and leaves the column empty', async () => {
    await migrateSqliteToLatest(db);
    const store = new SqliteSessionStore(db);
    await seedChat(store, 'chat-new');

    await store.createTurn(
      makeCreateTurnInput({
        sessionId: 'chat-new',
        turnId: 'turn-1',
        update_session_title_if_not_exist: 'Plan my week',
      }),
    );

    expect((await store.getSession({ tenant_id: TENANT, session_id: 'chat-new' }))?.title).toBe('Plan my week');
    expect(await titleSources(db)).toEqual({ 'chat-new': null });
  });
});

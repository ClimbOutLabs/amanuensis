import { readFile } from 'node:fs/promises';

import { MAIN_THREAD_ID } from '@truefoundry/trueforge-core/agent-session';
import { sql } from 'kysely';

import { makeAgentSpec, makeCreateTurnInput } from '../../../../../trueforge-core/tests/agent-session/testHelpers';

import { SentinelAuditStore } from '../../../../src/db/sentinelAuditStore';
import { SqliteApprovalTokenStore } from '../../../../src/db/sqlite/approval-token-store/SqliteApprovalTokenStore';
import { SqliteChatDeletionStore } from '../../../../src/db/sqlite/chat-deletion-store/SqliteChatDeletionStore';
import { SqliteChatImageStore } from '../../../../src/db/sqlite/chat-image-store/SqliteChatImageStore';
import { SqliteSessionStore } from '../../../../src/db/sqlite/session-store/SqliteSessionStore';
import { SqliteTurnArtifactStore } from '../../../../src/db/sqlite/turn-artifact-store/SqliteTurnArtifactStore';
import {
  CHAT_OWNED_TABLES,
  runChatDeletionStoreContractSuite,
  type ChatDeletionStoreContractFixtures,
} from '../../chatDeletionStoreContractSuite';
import { createSqliteTestDatabase, type SqliteTestDatabase } from '../testDatabase';

async function count(env: SqliteTestDatabase, query: ReturnType<typeof sql<{ n: number }>>): Promise<number> {
  const { rows } = await query.execute(env.db);
  return Number(rows[0]?.n ?? 0);
}

describe('SqliteChatDeletionStore (IChatDeletionStore contract)', () => {
  let env: SqliteTestDatabase;
  let fixtures: ChatDeletionStoreContractFixtures;

  beforeEach(async () => {
    env = await createSqliteTestDatabase();
    const artifacts = new SqliteTurnArtifactStore(env.db);
    fixtures = {
      sessions: new SqliteSessionStore(env.db),
      deletion: new SqliteChatDeletionStore({ db: env.db, turnArtifactStore: artifacts }),
      artifacts,
      images: new SqliteChatImageStore(env.db),
      approvalTokens: new SqliteApprovalTokenStore(env.db),
      audit: new SentinelAuditStore(env.db),
      chatOwnedTables: [...CHAT_OWNED_TABLES, 'turn_thread_context'],
      countChatRows: ({ table, session_id }) =>
        count(env, sql<{ n: number }>`SELECT count(*) AS n FROM ${sql.table(table)} WHERE session_id = ${session_id}`),
      countBlobs: () => count(env, sql<{ n: number }>`SELECT count(*) AS n FROM artifact_blob`),
      countApprovalTokens: () => count(env, sql<{ n: number }>`SELECT count(*) AS n FROM approval_token`),
    };
  }, 120_000);

  afterEach(async () => {
    await env?.teardown();
  });

  runChatDeletionStoreContractSuite(() => fixtures);
});

describe('SqliteChatDeletionStore on disk', () => {
  let env: SqliteTestDatabase;

  beforeEach(async () => {
    env = await createSqliteTestDatabase();
  }, 120_000);

  afterEach(async () => {
    await env?.teardown();
  });

  async function fileHolds(words: string): Promise<boolean> {
    const files = await Promise.all(
      ['', '-wal'].map(suffix => readFile(`${env.databaseFile}${suffix}`).catch(() => Buffer.alloc(0))),
    );
    return files.some(bytes => bytes.includes(words));
  }

  it("leaves none of a deleted chat's words in the database file or its write-ahead log", async () => {
    const sessions = new SqliteSessionStore(env.db);
    const words = 'the private ferry question';
    await sessions.createSession({
      tenant_id: 'default',
      session_id: 'private-chat',
      created_by_subject: { subject_id: 'user-a', subject_type: 'user', subject_display_name: 'user-a' },
      external_id: null,
      source: null,
      metadata: {},
      agent: { type: 'inline', spec: makeAgentSpec() },
      custom: null,
      is_incognito: true,
      private_expires_at: new Date(Date.now() + 60 * 60 * 1000),
    });
    await sessions.createTurn(
      makeCreateTurnInput({
        sessionId: 'private-chat',
        turnId: 'private-turn',
        new_context_appends: [
          { thread_id: MAIN_THREAD_ID, context: [{ role: 'user', content: words }], current_context_usage: null },
        ],
      }),
    );
    expect(await fileHolds(words)).toBe(true);

    const deletion = new SqliteChatDeletionStore({
      db: env.db,
      turnArtifactStore: new SqliteTurnArtifactStore(env.db),
    });
    expect(await deletion.deleteChat({ tenant_id: 'default', session_id: 'private-chat', expired_by: undefined })).toBe(
      true,
    );
    expect(await fileHolds(words)).toBe(false);
  });
});

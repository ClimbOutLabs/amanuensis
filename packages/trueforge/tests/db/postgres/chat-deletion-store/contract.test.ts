import { sql } from 'kysely';

import { PostgresApprovalTokenStore } from '../../../../src/db/postgres/approval-token-store/PostgresApprovalTokenStore';
import { PostgresChatDeletionStore } from '../../../../src/db/postgres/chat-deletion-store/PostgresChatDeletionStore';
import { PostgresChatImageStore } from '../../../../src/db/postgres/chat-image-store/PostgresChatImageStore';
import { PostgresSessionStore } from '../../../../src/db/postgres/session-store/PostgresSessionStore';
import { PostgresTurnArtifactStore } from '../../../../src/db/postgres/turn-artifact-store/PostgresTurnArtifactStore';
import { SentinelAuditStore } from '../../../../src/db/sentinelAuditStore';
import {
  CHAT_OWNED_TABLES,
  runChatDeletionStoreContractSuite,
  type ChatDeletionStoreContractFixtures,
} from '../../chatDeletionStoreContractSuite';
import { createPostgresTestDatabase, type PostgresTestDatabase } from '../testDatabase';

const describePg = process.env['PG_STORE_TESTS_ENABLED'] === '1' ? describe : describe.skip;

describePg('PostgresChatDeletionStore (IChatDeletionStore contract)', () => {
  let env: PostgresTestDatabase | undefined;
  let fixtures: ChatDeletionStoreContractFixtures | undefined;

  beforeEach(async () => {
    const created = await createPostgresTestDatabase();
    if (created === undefined) {
      throw new Error('Postgres test environment unavailable despite globalSetup probe');
    }
    env = created;
    const count = async (query: ReturnType<typeof sql<{ n: string }>>): Promise<number> => {
      const { rows } = await query.execute(created.db);
      return Number(rows[0]?.n ?? 0);
    };
    const artifacts = new PostgresTurnArtifactStore(created.db);
    fixtures = {
      sessions: new PostgresSessionStore(created.db),
      deletion: new PostgresChatDeletionStore({ db: created.db, turnArtifactStore: artifacts }),
      artifacts,
      images: new PostgresChatImageStore(created.db),
      approvalTokens: new PostgresApprovalTokenStore(created.db),
      audit: new SentinelAuditStore(created.db),
      chatOwnedTables: CHAT_OWNED_TABLES,
      countChatRows: ({ table, session_id }) =>
        count(sql<{ n: string }>`SELECT count(*) AS n FROM ${sql.table(table)} WHERE session_id = ${session_id}`),
      countBlobs: () => count(sql<{ n: string }>`SELECT count(*) AS n FROM artifact_blob`),
      countApprovalTokens: () => count(sql<{ n: string }>`SELECT count(*) AS n FROM approval_token`),
    };
  }, 120_000);

  afterEach(async () => {
    await env?.teardown();
  });

  runChatDeletionStoreContractSuite(() => {
    if (fixtures === undefined) {
      throw new Error('Postgres test environment not initialized');
    }
    return fixtures;
  });
});

import { sql } from 'kysely';

import { PostgresMcpToolGrantStore } from '../../../../src/db/postgres/mcp-tool-grant-store/PostgresMcpToolGrantStore';
import { runMcpToolGrantStoreContractSuite } from '../../mcpToolGrantStoreContractSuite';
import { createPostgresTestDatabase, type PostgresTestDatabase } from '../testDatabase';

const describePg = process.env['PG_STORE_TESTS_ENABLED'] === '1' ? describe : describe.skip;

describePg('PostgresMcpToolGrantStore (IMcpToolGrantStore contract)', () => {
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
      await sql`TRUNCATE TABLE mcp_tool_grant`.execute(env.db);
    }
  });

  runMcpToolGrantStoreContractSuite(
    () => {
      if (env === undefined) {
        throw new Error('Postgres test environment not initialized');
      }
      return new PostgresMcpToolGrantStore(env.db);
    },
    async key => {
      if (env === undefined) {
        throw new Error('Postgres test environment not initialized');
      }
      await env.db
        .insertInto('mcp_tool_grant')
        .values({
          tenant_id: key.tenant_id,
          created_by: key.created_by,
          mcp_server_name: key.mcp_server_name,
          tool_name: key.tool_name,
          mcp_server_id: '',
          connector_fingerprint: '',
          created_at: new Date(),
        })
        .execute();
    },
  );
});

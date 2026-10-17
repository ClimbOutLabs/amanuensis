import { SqliteMcpToolGrantStore } from '../../../../src/db/sqlite/mcp-tool-grant-store/SqliteMcpToolGrantStore';
import { runMcpToolGrantStoreContractSuite } from '../../mcpToolGrantStoreContractSuite';
import { createSqliteTestDatabase, type SqliteTestDatabase } from '../testDatabase';

describe('SqliteMcpToolGrantStore (IMcpToolGrantStore contract)', () => {
  let env: SqliteTestDatabase;

  beforeEach(async () => {
    env = await createSqliteTestDatabase();
  }, 120_000);

  afterEach(async () => {
    await env?.teardown();
  });

  runMcpToolGrantStoreContractSuite(
    () => new SqliteMcpToolGrantStore(env.db),
    async key => {
      await env.db
        .insertInto('mcp_tool_grant')
        .values({
          tenant_id: key.tenant_id,
          created_by: key.created_by,
          mcp_server_name: key.mcp_server_name,
          tool_name: key.tool_name,
          mcp_server_id: '',
          connector_fingerprint: '',
          created_at: new Date().toISOString(),
        })
        .execute();
    },
  );
});

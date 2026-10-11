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

  runMcpToolGrantStoreContractSuite(() => new SqliteMcpToolGrantStore(env.db));
});

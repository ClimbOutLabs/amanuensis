import {
  classifyHostToolCall,
  createSentinelHostContext,
  InMemoryApprovalTokenStore,
  verifyPreDispatch,
  type SentinelAction,
  type SentinelServices,
} from '@truefoundry/trueforge-core/core';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { SentinelAuditStore } from '../../../src/db/sentinelAuditStore';
import { SqliteApprovalTokenStore } from '../../../src/db/sqlite/approval-token-store/SqliteApprovalTokenStore';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteMcpToolGrantStore } from '../../../src/db/sqlite/mcp-tool-grant-store/SqliteMcpToolGrantStore';
import { SqliteSentinelSettingsStore } from '../../../src/db/sqlite/sentinel-settings-store/SqliteSentinelSettingsStore';
import { createSentinelServices } from '../../../src/runtime/sentinelServices';

const alice = { tenant_id: 't1', created_by: 'alice' };
const params = { command: 'curl https://example.com/a' };
const action: SentinelAction = {
  tool_name: 'exec',
  canonical_params: params,
  tool_type: 'truefoundry-system',
  mcp_hints: {},
};

/** The server's Sentinel composition over one SQLite file, as main.ts builds it. */
function composeOver(db: ReturnType<typeof createSqliteDb>): SentinelServices {
  return createSentinelServices({
    audit: new SentinelAuditStore(db),
    settings: new SqliteSentinelSettingsStore(db),
    approvalTokens: new SqliteApprovalTokenStore(db),
    toolGrants: new SqliteMcpToolGrantStore(db),
    outboundSecrets: () => Promise.resolve([]),
  });
}

describe('createSentinelServices', () => {
  let directory: string;
  let databaseFile: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'tfy-sentinel-services-'));
    databaseFile = join(directory, 'sentinel.sqlite');
    const db = createSqliteDb(databaseFile);
    try {
      await migrateSqliteToLatest(db);
    } finally {
      await db.destroy();
    }
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('uses the given approval token and tool grant stores instead of the in-memory defaults', async () => {
    const approvalTokens = new InMemoryApprovalTokenStore();
    const db = createSqliteDb(databaseFile);
    const toolGrants = new SqliteMcpToolGrantStore(db);
    try {
      const services = createSentinelServices({
        audit: new SentinelAuditStore(db),
        settings: new SqliteSentinelSettingsStore(db),
        approvalTokens,
        toolGrants,
        outboundSecrets: () => Promise.resolve([]),
      });
      expect(services.token_store).toBe(approvalTokens);
      expect(services.tool_grants).toBe(toolGrants);
    } finally {
      await db.destroy();
    }
  });

  it('an approval minted before a restart still authorizes the call once, for the same user only', async () => {
    const first = createSqliteDb(databaseFile);
    const decision = await (async () => {
      try {
        const host = createSentinelHostContext({ ...alice, conversation_id: 'c1', services: composeOver(first) });
        return await classifyHostToolCall({ sentinel: host, repository_id: null, workspace_cwd: null, action });
      } finally {
        await first.destroy();
      }
    })();
    expect(decision.tier).toBe(3);
    const approvalTokenId = decision.approval_token_id ?? null;
    expect(approvalTokenId).not.toBeNull();

    const restarted = createSqliteDb(databaseFile);
    try {
      const services = composeOver(restarted);
      const verify = (identity: { tenant_id: string; created_by: string }) =>
        verifyPreDispatch({
          call: {
            tool_name: 'exec',
            tool_type: 'truefoundry-system',
            canonical_params: params,
            tier: 3,
            approval_token_id: approvalTokenId,
            approval_binding: decision.approval_binding ?? null,
            shell_binding: decision.shell_binding ?? null,
          },
          ctx: {
            ...identity,
            conversation_id: 'c1',
            repository_id: null,
            workspace_cwd: null,
            agent_intent: null,
            services,
            offline: false,
          },
        });

      expect(await verify({ ...alice, created_by: 'mallory' })).toMatch(/invalid or was already used/);
      expect(await verify(alice)).toBeUndefined();
      expect(await verify(alice)).toMatch(/invalid or was already used/);
    } finally {
      await restarted.destroy();
    }
  });
});

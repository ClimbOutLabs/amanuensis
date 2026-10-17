import type { Transaction } from 'kysely';
import { existsSync } from 'node:fs';

import { migrateSqliteToLatest } from '../../db/migrateSqlite';
import { SentinelAuditStore } from '../../db/sentinelAuditStore';
import { SqliteAgentStore } from '../../db/sqlite/agent-store/SqliteAgentStore';
import { createSqliteDb } from '../../db/sqlite/client';
import { SqliteGlobalSettingsStore } from '../../db/sqlite/global-settings-store/SqliteGlobalSettingsStore';
import { SqliteMcpServerStore } from '../../db/sqlite/mcp-server-store/SqliteMcpServerStore';
import { SqliteModelProviderStore } from '../../db/sqlite/model-provider-store/SqliteModelProviderStore';
import { SqlitePersonaStore } from '../../db/sqlite/persona-store/SqlitePersonaStore';
import { SqlitePersonalizationStore } from '../../db/sqlite/personalization-store/SqlitePersonalizationStore';
import { SqliteSandboxProviderStore } from '../../db/sqlite/sandbox-provider-store/SqliteSandboxProviderStore';
import { SqliteScheduleStore } from '../../db/sqlite/schedule-store/SqliteScheduleStore';
import { SqliteSentinelSettingsStore } from '../../db/sqlite/sentinel-settings-store/SqliteSentinelSettingsStore';
import { SqliteSessionStore } from '../../db/sqlite/session-store/SqliteSessionStore';
import { SqliteSpaceStore } from '../../db/sqlite/space-store/SqliteSpaceStore';
import { SqliteOAuthTokenStore } from '../../db/sqlite/token-store/SqliteOAuthTokenStore';
import { SqliteTurnArtifactStore } from '../../db/sqlite/turn-artifact-store/SqliteTurnArtifactStore';
import type { Database as SqliteDatabase } from '../../db/sqlite/types';
import type { ExportStores } from './stores';

/** Opens an existing SQLite database; a missing file is an error, never an empty export. */
export async function openSqliteStores(options: {
  sqlitePath: string;
  migrate: boolean;
}): Promise<ExportStores<Transaction<SqliteDatabase>>> {
  if (!existsSync(options.sqlitePath)) {
    throw new Error(`No SQLite database at ${options.sqlitePath}. Check SQLITE_PATH and the data volume.`);
  }
  const db = createSqliteDb(options.sqlitePath);
  try {
    if (options.migrate) {
      await migrateSqliteToLatest(db);
    }
  } catch (error) {
    await db.destroy();
    throw error;
  }
  return {
    sessionStore: new SqliteSessionStore(db),
    personaStore: new SqlitePersonaStore(db),
    personalizationStore: new SqlitePersonalizationStore(db),
    spaceStore: new SqliteSpaceStore(db),
    scheduleStore: new SqliteScheduleStore(db),
    globalSettingsStore: new SqliteGlobalSettingsStore(db),
    sentinelSettingsStore: new SqliteSentinelSettingsStore(db),
    turnArtifactStore: new SqliteTurnArtifactStore(db),
    agentStore: new SqliteAgentStore(db),
    modelProviderStore: new SqliteModelProviderStore(db),
    sandboxProviderStore: new SqliteSandboxProviderStore(db),
    mcpServerStore: new SqliteMcpServerStore(db),
    tokenStore: new SqliteOAuthTokenStore(db),
    auditStore: new SentinelAuditStore(db),
    close: () => db.destroy(),
  };
}

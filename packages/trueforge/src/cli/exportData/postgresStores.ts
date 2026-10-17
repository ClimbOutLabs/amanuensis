import type { Transaction } from 'kysely';

import { migrateToLatest } from '../../db/migratePostgres';
import { PostgresAgentStore } from '../../db/postgres/agent-store/PostgresAgentStore';
import { createDb } from '../../db/postgres/client';
import { PostgresGlobalSettingsStore } from '../../db/postgres/global-settings-store/PostgresGlobalSettingsStore';
import { PostgresGoogleConnectionStore } from '../../db/postgres/google-connection-store/PostgresGoogleConnectionStore';
import { PostgresMcpServerStore } from '../../db/postgres/mcp-server-store/PostgresMcpServerStore';
import { PostgresModelProviderStore } from '../../db/postgres/model-provider-store/PostgresModelProviderStore';
import { PostgresPersonaStore } from '../../db/postgres/persona-store/PostgresPersonaStore';
import { PostgresPersonalizationStore } from '../../db/postgres/personalization-store/PostgresPersonalizationStore';
import { PostgresSandboxProviderStore } from '../../db/postgres/sandbox-provider-store/PostgresSandboxProviderStore';
import { PostgresScheduleStore } from '../../db/postgres/schedule-store/PostgresScheduleStore';
import { PostgresSentinelSettingsStore } from '../../db/postgres/sentinel-settings-store/PostgresSentinelSettingsStore';
import { PostgresSessionStore } from '../../db/postgres/session-store/PostgresSessionStore';
import { PostgresSpaceStore } from '../../db/postgres/space-store/PostgresSpaceStore';
import { PostgresOAuthTokenStore } from '../../db/postgres/token-store/PostgresOAuthTokenStore';
import { PostgresTurnArtifactStore } from '../../db/postgres/turn-artifact-store/PostgresTurnArtifactStore';
import type { Database as PostgresDatabase } from '../../db/postgres/types';
import { SentinelAuditStore } from '../../db/sentinelAuditStore';
import type { ExportStores } from './stores';

export async function openPostgresStores(options: {
  connectionString: string;
  poolMax: number;
  statementTimeoutMs: number;
  idleInTransactionSessionTimeoutMs: number;
  migrate: boolean;
}): Promise<ExportStores<Transaction<PostgresDatabase>>> {
  const db = createDb({
    connectionString: options.connectionString,
    poolMax: options.poolMax,
    statementTimeoutMs: options.statementTimeoutMs,
    idleInTransactionSessionTimeoutMs: options.idleInTransactionSessionTimeoutMs,
  });
  try {
    if (options.migrate) {
      await migrateToLatest(db);
    }
  } catch (error) {
    await db.destroy();
    throw error;
  }
  return {
    sessionStore: new PostgresSessionStore(db),
    personaStore: new PostgresPersonaStore(db),
    personalizationStore: new PostgresPersonalizationStore(db),
    spaceStore: new PostgresSpaceStore(db),
    scheduleStore: new PostgresScheduleStore(db),
    globalSettingsStore: new PostgresGlobalSettingsStore(db),
    sentinelSettingsStore: new PostgresSentinelSettingsStore(db),
    turnArtifactStore: new PostgresTurnArtifactStore(db),
    agentStore: new PostgresAgentStore(db),
    modelProviderStore: new PostgresModelProviderStore(db),
    sandboxProviderStore: new PostgresSandboxProviderStore(db),
    mcpServerStore: new PostgresMcpServerStore(db),
    tokenStore: new PostgresOAuthTokenStore(db),
    googleConnectionStore: new PostgresGoogleConnectionStore(db),
    auditStore: new SentinelAuditStore(db),
    close: () => db.destroy(),
  };
}

import type { Kysely, Transaction } from 'kysely';
import { SqliteAgentStore } from '../../db/sqlite/agent-store/SqliteAgentStore';
import { SqliteGlobalSettingsStore } from '../../db/sqlite/global-settings-store/SqliteGlobalSettingsStore';
import { SqliteMcpServerStore } from '../../db/sqlite/mcp-server-store/SqliteMcpServerStore';
import { SqlitePersonaStore } from '../../db/sqlite/persona-store/SqlitePersonaStore';
import { SqlitePersonalizationStore } from '../../db/sqlite/personalization-store/SqlitePersonalizationStore';
import { SqliteScheduleStore } from '../../db/sqlite/schedule-store/SqliteScheduleStore';
import { SqliteSessionStore } from '../../db/sqlite/session-store/SqliteSessionStore';
import { SqliteSkillStore } from '../../db/sqlite/skill-store/SqliteSkillStore';
import { SqliteSpaceStore } from '../../db/sqlite/space-store/SqliteSpaceStore';
import { SqliteTurnArtifactStore } from '../../db/sqlite/turn-artifact-store/SqliteTurnArtifactStore';
import type { Database } from '../../db/sqlite/types';
import { MarkdownMemoryClient } from '../../runtime/memory/markdownMemoryClient';
import { EncryptedMcpServerStore } from '../../secrets/encryptedMcpServerStore';
import type { SecretVault } from '../../secrets/secretVault';
import type { DemoKnowledgeLibrary } from './knowledgeLibrary';
import type { DemoSeedStores } from './seed';

/** The same SQLite stores and local markdown memory the server uses, opened on an existing database. */
export function createSqliteDemoSeedStores({
  db,
  memoryDir,
  tenantId,
  knowledge,
  vault,
}: {
  db: Kysely<Database>;
  memoryDir: string;
  tenantId: string;
  knowledge: DemoKnowledgeLibrary;
  /** Connectors the seed saves go through it, so their keys are encrypted like any other. */
  vault: SecretVault;
}): DemoSeedStores<Transaction<Database>> {
  return {
    withTransaction: callback => db.transaction().execute(callback),
    personaStore: new SqlitePersonaStore(db),
    personalizationStore: new SqlitePersonalizationStore(db),
    agentStore: new SqliteAgentStore(db),
    scheduleStore: new SqliteScheduleStore(db),
    spaceStore: new SqliteSpaceStore(db),
    sessionStore: new SqliteSessionStore(db),
    turnArtifactStore: new SqliteTurnArtifactStore(db),
    mcpServerStore: new EncryptedMcpServerStore({ store: new SqliteMcpServerStore(db), vault }),
    globalSettingsStore: new SqliteGlobalSettingsStore(db),
    skillStore: new SqliteSkillStore(db),
    knowledge,
    memory: new MarkdownMemoryClient({ baseDir: memoryDir, namespace: tenantId }),
  };
}

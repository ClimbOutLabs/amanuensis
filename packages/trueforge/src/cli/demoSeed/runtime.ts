import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from 'winston';
import { McpCatalog } from '../../catalog/McpCatalog';
import { SkillCatalog } from '../../catalog/SkillCatalog';
import { flattenProviderModels } from '../../db/modelProviderStore';
import { getPersonaKnowledgeIndexer } from '../../personaKnowledge/knowledgeIndexer';
import { createKnowledgeLibrary } from './knowledgeLibrary';
import { buildDemoSession, type DemoSeedSession } from './session';

/**
 * Server config validates the environment when it is imported, so it is loaded only here, after the
 * command line has been accepted, and never by the dispatcher or by other commands.
 */
export async function isDemoModeEnabled(): Promise<boolean> {
  const { default: configuration } = await import('../../config');
  return configuration.DEMO_MODE;
}

export async function openDemoSeedSession(): Promise<DemoSeedSession> {
  const [{ default: configuration }, { createSqliteDb }, { migrateSqliteToLatest }, { SqliteModelProviderStore }] =
    await Promise.all([
      import('../../config'),
      import('../../db/sqlite/client'),
      import('../../db/migrateSqlite'),
      import('../../db/sqlite/model-provider-store/SqliteModelProviderStore'),
    ]);
  if (!configuration.STANDALONE) {
    throw new Error('demo-seed writes to the standalone (SQLite) instance only. Set STANDALONE=true.');
  }
  if (configuration.MEMORY_BACKEND !== 'markdown') {
    throw new Error('demo-seed writes to the local markdown memory. Set MEMORY_BACKEND=markdown.');
  }
  await mkdir(path.dirname(configuration.SQLITE_PATH), { recursive: true });
  const db = createSqliteDb(configuration.SQLITE_PATH);
  try {
    await migrateSqliteToLatest(db);
    const { TENANT_ID } = await import('../../tenancy');
    const providers = await new SqliteModelProviderStore(db).listProviders({ tenant_id: TENANT_ID });
    // The seed indexes the personas' libraries itself; the logger is quiet because the status of each document is reported.
    const indexer = getPersonaKnowledgeIndexer({
      knowledgeDir: configuration.PERSONA_KNOWLEDGE_DIR,
      modelDir: configuration.MEMORY_EMBEDDINGS_MODEL_DIR,
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    });
    return buildDemoSession({
      db,
      tenantId: TENANT_ID,
      memoryDir: configuration.MEMORY_MARKDOWN_DIR,
      models: flattenProviderModels(providers).map(model => model.name),
      connectors: {
        mailUrl: configuration.MAIL_EMAIL_MCP_URL,
        catalog: McpCatalog.load(configuration.MCP_CATALOG_PATH),
        skillCatalog: SkillCatalog.load(),
        // The seed reports connector outcomes itself; the boot steps' own log lines would only repeat them.
        logger: createLogger({ silent: true }),
      },
      knowledge: createKnowledgeLibrary({
        knowledgeDir: configuration.PERSONA_KNOWLEDGE_DIR,
        tenantId: TENANT_ID,
        enqueue: ({ personaId, documentId }) => {
          indexer.enqueue({ tenantId: TENANT_ID, personaId, documentId });
        },
      }),
    });
  } catch (error) {
    await db.destroy();
    throw error;
  }
}

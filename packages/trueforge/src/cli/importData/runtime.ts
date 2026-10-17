import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { createLogger, format, transports } from 'winston';

import type { ImportDataSession } from './session';

/** Messages go to stderr so stdout stays the one JSON result. */
function stderrLogger() {
  return createLogger({
    format: format.combine(format.timestamp(), format.json()),
    transports: [new transports.Console({ stderrLevels: ['error', 'warn', 'info'] })],
  });
}

/** Migration progress is printed with console.log, but stdout is reserved for the one JSON result. */
async function withLogsOnStderr<T>(run: () => Promise<T>): Promise<T> {
  const original = console.log;
  console.log = (...args: unknown[]) => {
    console.error(...args);
  };
  try {
    return await run();
  } finally {
    console.log = original;
  }
}

/**
 * Server config validates the environment when it is imported, so it is loaded only here, after the
 * command line has been accepted. Writes to the standalone instance's SQLite database and its
 * Markdown memory, the same files the server reads.
 */
export async function openImportDataSession(): Promise<ImportDataSession> {
  const [
    { default: configuration, getTrueForgeAuthMode, TrueForgeAuthMode },
    { STANDALONE_REQUEST_CONTEXT },
    { createSqliteDb },
    { migrateSqliteToLatest },
    { TENANT_ID },
    { runDataImport },
    { getSharedEmbeddingModel, isEmbeddingModelCached },
    { SentinelAuditStore },
    { McpCatalog },
  ] = await Promise.all([
    import('../../config'),
    import('../../auth/identity'),
    import('../../db/sqlite/client'),
    import('../../db/migrateSqlite'),
    import('../../tenancy'),
    import('../../dataImport/importService'),
    import('../../runtime/memory/embeddingModel'),
    import('../../db/sentinelAuditStore'),
    import('../../catalog/McpCatalog'),
  ]);
  if (!configuration.STANDALONE) {
    throw new Error('import-data writes to the standalone (SQLite) instance only. Set STANDALONE=true.');
  }
  if (configuration.MEMORY_BACKEND !== 'markdown') {
    throw new Error('import-data writes to the local markdown memory. Set MEMORY_BACKEND=markdown.');
  }

  // The owner is whoever the app itself will treat as the one account.
  let owner: string;
  if (getTrueForgeAuthMode(configuration) === TrueForgeAuthMode.Oidc && configuration.OIDC !== undefined) {
    const { OIDC_ADMIN_ROLE_VALUE, OIDC_USER_REFERENCE_CLAIM, OIDC_USER_ROLE_CLAIM } = configuration.OIDC;
    if (OIDC_USER_REFERENCE_CLAIM !== OIDC_USER_ROLE_CLAIM) {
      throw new Error(
        "The owner cannot be told from this instance's settings. Set OIDC_USER_ROLE_CLAIM to the same claim as OIDC_USER_REFERENCE_CLAIM (as installer instances do).",
      );
    }
    owner = OIDC_ADMIN_ROLE_VALUE;
  } else {
    owner = STANDALONE_REQUEST_CONTEXT.subject.id;
  }

  await mkdir(path.dirname(configuration.SQLITE_PATH), { recursive: true });
  const db = createSqliteDb(configuration.SQLITE_PATH);
  try {
    await withLogsOnStderr(() => migrateSqliteToLatest(db));
  } catch (error) {
    await db.destroy();
    throw error;
  }

  const [
    { SqliteAgentStore },
    { SqliteGlobalSettingsStore },
    { SqliteMcpServerStore },
    { SqlitePersonaStore },
    { SqlitePersonalizationStore },
    { SqliteScheduleStore },
    { SqliteSessionStore },
    { SqliteSpaceStore },
    { SqliteTurnArtifactStore },
  ] = await Promise.all([
    import('../../db/sqlite/agent-store/SqliteAgentStore'),
    import('../../db/sqlite/global-settings-store/SqliteGlobalSettingsStore'),
    import('../../db/sqlite/mcp-server-store/SqliteMcpServerStore'),
    import('../../db/sqlite/persona-store/SqlitePersonaStore'),
    import('../../db/sqlite/personalization-store/SqlitePersonalizationStore'),
    import('../../db/sqlite/schedule-store/SqliteScheduleStore'),
    import('../../db/sqlite/session-store/SqliteSessionStore'),
    import('../../db/sqlite/space-store/SqliteSpaceStore'),
    import('../../db/sqlite/turn-artifact-store/SqliteTurnArtifactStore'),
  ]);

  const modelDir = configuration.MEMORY_EMBEDDINGS_MODEL_DIR;
  const embeddingModel = getSharedEmbeddingModel({ modelDir });
  const logger = stderrLogger();
  const audit = new SentinelAuditStore(db);
  const mcpCatalog = McpCatalog.load();

  return {
    owner,
    importArchive: ({ archive, userId, displayName }) =>
      runDataImport(
        {
          sessionStore: new SqliteSessionStore(db),
          personaStore: new SqlitePersonaStore(db),
          personalizationStore: new SqlitePersonalizationStore(db),
          spaceStore: new SqliteSpaceStore(db),
          scheduleStore: new SqliteScheduleStore(db),
          globalSettingsStore: new SqliteGlobalSettingsStore(db),
          auditStore: audit,
          turnArtifactStore: new SqliteTurnArtifactStore(db),
          mcpServerStore: new SqliteMcpServerStore(db),
          agentStore: new SqliteAgentStore(db),
          mcpCatalog,
          withTransaction: callback => db.transaction().execute(callback),
          memoryTarget: { kind: 'markdown', markdownDir: configuration.MEMORY_MARKDOWN_DIR },
          personaKnowledgeDir: configuration.PERSONA_KNOWLEDGE_DIR,
          // The one-off container has no network: a model that is not on disk is "not ready", never fetched.
          knowledgeEmbedder: {
            ensureReady: () =>
              isEmbeddingModelCached(modelDir) ? embeddingModel.ensureReady() : Promise.resolve(false),
            embedPassages: texts => embeddingModel.embedPassages(texts),
          },
          logger,
        },
        {
          archive,
          subject: { tenantId: TENANT_ID, subjectId: userId, subjectDisplayName: displayName, agentIds: [] },
          maxBytes: configuration.DATA_IMPORT_MAX_BYTES,
        },
      ),
    recordAudit: ({ userId, description }) =>
      audit.record({
        tenant_id: TENANT_ID,
        created_by: userId,
        conversation_id: '',
        tier: 1,
        tool_name: 'data_import',
        description,
        outcome: 'logged',
        auto_deny_reason: null,
      }),
    close: () => db.destroy(),
  };
}

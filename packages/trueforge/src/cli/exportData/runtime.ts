import { createLogger } from 'winston';

import type { AgentRecord } from '../../db/agentStore';
import type { ExportDataSession, SessionOwner } from './session';
import type { ExportStores } from './stores';

const OWNER_PAGE_LIMIT = 200;

/** Audit rows written by the command line carry this actor instead of a signed-in user. */
const AUDIT_ACTOR = 'cli';

/** Runs the same export as the HTTP route against stores the command opened itself. */
async function buildSession<TTransaction>({
  stores,
  signInOffUserId,
}: {
  stores: ExportStores<TTransaction>;
  signInOffUserId: string | undefined;
}): Promise<ExportDataSession> {
  const [
    { default: configuration, getConfiguredSecretValues },
    { TENANT_ID },
    exportService,
    secrets,
    envFile,
    memory,
    outbound,
  ] = await Promise.all([
    import('../../config'),
    import('../../tenancy'),
    import('../../dataExport/exportService'),
    import('../../dataExport/secretScrub'),
    import('../../dataExport/envFileSecrets'),
    import('../../dataExport/memorySource'),
    import('../../runtime/outboundSecrets'),
  ]);
  const { PACKAGE_VERSION } = await import('../../packageVersion');
  const outboundSecrets = outbound.createOutboundSecretSource({
    configured: () => getConfiguredSecretValues(configuration),
    modelProviders: stores.modelProviderStore,
    sandboxProviders: stores.sandboxProviderStore,
    mcpServers: stores.mcpServerStore,
    tokens: stores.tokenStore,
    googleConnections: stores.googleConnectionStore,
  });
  // Memory provider lookups log through this; the command reports failures itself.
  const logger = createLogger({ silent: true });

  async function listOwners(): Promise<SessionOwner[]> {
    const owners = new Map<string, SessionOwner>();
    let pageToken: string | undefined;
    for (;;) {
      const page = await stores.sessionStore.listSessions({
        tenant_id: TENANT_ID,
        limit: OWNER_PAGE_LIMIT,
        page_token: pageToken,
        order: 'asc',
        start_timestamp: undefined,
        end_timestamp: undefined,
        agent_id: undefined,
        created_by_or_agent_ids: undefined,
        metadata: undefined,
        source_type: undefined,
        source_id: undefined,
      });
      for (const session of page.data) {
        const { subject_id: userId, subject_display_name: displayName } = session.created_by_subject;
        const known = owners.get(userId);
        if (known === undefined) {
          owners.set(userId, { user_id: userId, display_name: displayName, sessions: 1 });
        } else {
          known.sessions += 1;
        }
      }
      if (page.pagination.next_page_token === undefined) {
        break;
      }
      pageToken = page.pagination.next_page_token;
    }
    if (signInOffUserId !== undefined && !owners.has(signInOffUserId)) {
      owners.set(signInOffUserId, { user_id: signInOffUserId, display_name: signInOffUserId, sessions: 0 });
    }
    return [...owners.values()].sort((a, b) => b.sessions - a.sessions || a.user_id.localeCompare(b.user_id));
  }

  async function listUserAgents(userId: string): Promise<AgentRecord[]> {
    // Same rule as the server's authorizer on instances without an external policy: managing is creator-only.
    const agents: AgentRecord[] = [];
    let pageToken: string | undefined;
    for (;;) {
      const page = await stores.agentStore.listAgents({
        tenant_id: TENANT_ID,
        agent_name: undefined,
        include_host_managed: true,
        limit: OWNER_PAGE_LIMIT,
        page_token: pageToken,
      });
      agents.push(...page.data.filter(agent => agent.created_by_subject.subject_id === userId));
      if (page.pagination.next_page_token === undefined) {
        return agents;
      }
      pageToken = page.pagination.next_page_token;
    }
  }

  return {
    signInOffUserId,
    listOwners,
    exportUser: async ({ userId, includeUploads, includeInstanceData, secretsEnvText, out }) => {
      const secretValues = secrets.normalizeSecrets([
        ...(await outboundSecrets({ tenant_id: TENANT_ID, created_by: userId })),
        ...(secretsEnvText === undefined ? [] : envFile.envFileSecretValues(secretsEnvText)),
      ]);
      const memorySource = await memory.resolveMemoryExportSource({
        mcpServerStore: stores.mcpServerStore,
        tokenStore: stores.tokenStore,
        tenantId: TENANT_ID,
        subjectId: userId,
        logger,
      });
      return exportService.runDataExport(
        {
          sessionStore: stores.sessionStore,
          personaStore: stores.personaStore,
          personalizationStore: stores.personalizationStore,
          spaceStore: stores.spaceStore,
          scheduleStore: stores.scheduleStore,
          globalSettingsStore: stores.globalSettingsStore,
          sentinelSettingsStore: stores.sentinelSettingsStore,
          auditStore: stores.auditStore,
          turnArtifactStore: stores.turnArtifactStore,
          mcpServerStore: stores.mcpServerStore,
          modelProviderStore: stores.modelProviderStore,
          listAgents: () => listUserAgents(userId),
          memorySource,
          personaKnowledgeDir: configuration.PERSONA_KNOWLEDGE_DIR,
        },
        {
          subject: { tenantId: TENANT_ID, subjectId: userId, includeUploads, includeInstanceData },
          secrets: secretValues,
          exportedAt: new Date(),
          appVersion: PACKAGE_VERSION,
          maxBytes: configuration.DATA_EXPORT_MAX_BYTES,
        },
        out,
      );
    },
    recordAudit: ({ description }) =>
      stores.auditStore.record({
        tenant_id: TENANT_ID,
        created_by: AUDIT_ACTOR,
        conversation_id: '',
        tier: 1,
        tool_name: 'data_export',
        description,
        outcome: 'logged',
        auto_deny_reason: null,
      }),
    close: () => stores.close(),
  };
}

/**
 * Server config validates the environment when it is imported, so it is loaded only here, after
 * the command line has been accepted. Reads the same database the server would: SQLite when
 * STANDALONE is true, Postgres otherwise.
 */
export async function openExportDataSession({ migrate }: { migrate: boolean }): Promise<ExportDataSession> {
  const [{ default: configuration, getTrueForgeAuthMode, isTrueFoundryModeEnabled, TrueForgeAuthMode }, identity] =
    await Promise.all([import('../../config'), import('../../auth/identity')]);
  if (isTrueFoundryModeEnabled(configuration)) {
    throw new Error('export-data reads the instance database; TrueFoundry mode keeps its data elsewhere.');
  }
  const signInOffUserId =
    getTrueForgeAuthMode(configuration) === TrueForgeAuthMode.Standalone
      ? identity.STANDALONE_REQUEST_CONTEXT.subject.id
      : undefined;
  if (configuration.STANDALONE) {
    const { openSqliteStores } = await import('./sqliteStores');
    const stores = await openSqliteStores({ sqlitePath: configuration.SQLITE_PATH, migrate });
    return buildSession({ stores, signInOffUserId });
  }
  const { openPostgresStores } = await import('./postgresStores');
  const stores = await openPostgresStores({
    connectionString: configuration.DATABASE_URL,
    poolMax: configuration.DATABASE_POOL_MAX,
    statementTimeoutMs: configuration.POSTGRES_STATEMENT_TIMEOUT_MS,
    idleInTransactionSessionTimeoutMs: configuration.POSTGRES_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS,
    migrate,
  });
  return buildSession({ stores, signInOffUserId });
}

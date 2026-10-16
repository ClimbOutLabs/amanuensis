/**
 * GET /api/v1/data/export: streams the signed-in user's data export archive.
 *
 * Scope is the caller plus the agents they manage, resolved the same way as
 * the session APIs. One audit row is recorded per completed export (who and
 * when, never content).
 */
import { OpenAPIHono } from '@hono/zod-openapi';
import type { ISessionStore } from '@truefoundry/trueforge-core/agent-session';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { stream } from 'hono/streaming';
import { Writable } from 'node:stream';
import { finished } from 'node:stream/promises';

import type { Logger } from 'winston';
import type { Authorizer } from '../auth/authorizer';
import { resolveRequestContext } from '../auth/identity';
import configuration from '../config';
import { runDataExport, type MemoryExportSource } from '../dataExport/exportService';
import { collectStoredSecrets } from '../dataExport/secretCollection';
import type { AgentRecord, IAgentStore } from '../db/agentStore';
import type { IGlobalSettingsStore } from '../db/globalSettingsStore';
import type { IMcpServerWithAuthStore } from '../db/mcpServerStore';
import type { IModelProviderStore } from '../db/modelProviderStore';
import type { IPersonaStore } from '../db/personaStore';
import type { IPersonalizationStore } from '../db/personalizationStore';
import type { IScheduleStore } from '../db/scheduleStore';
import type { ISentinelAuditStore } from '../db/sentinelAuditStore';
import type { ISentinelSettingsStore } from '../db/sentinelSettingsStore';
import type { SessionCustom, TurnCustom } from '../db/sessionCustom';
import type { ISpaceStore } from '../db/spaceStore';
import type { ITurnArtifactStore } from '../db/turnArtifactStore';
import type { IOAuthTokenStore } from '../mcp/auth/types';
import { PACKAGE_VERSION } from '../packageVersion';
import { exportDataRoute } from '../routes/dataExportRoutes';
import { createMemoryClient } from '../runtime/memory/createMemoryClient';
import type { MemoryClient } from '../runtime/memory/memoryClient';
import { resolveMemoryProvider } from '../runtime/memory/memoryProvider';
import { resolveManagedAgentIds } from './agentAccess';

export interface DataExportDeps<TTransaction> {
  sessionStore: ISessionStore<SessionCustom, TurnCustom>;
  personaStore: IPersonaStore<TTransaction>;
  personalizationStore: IPersonalizationStore<TTransaction>;
  spaceStore: ISpaceStore<TTransaction>;
  scheduleStore: IScheduleStore<TTransaction>;
  globalSettingsStore: IGlobalSettingsStore<TTransaction>;
  sentinelSettingsStore: ISentinelSettingsStore<TTransaction>;
  sentinelAuditStore: ISentinelAuditStore;
  turnArtifactStore: ITurnArtifactStore<TTransaction>;
  tokenStore: IOAuthTokenStore<TTransaction>;
  resolveMcpServerStore: (c?: Context, runAsAgent?: AgentRecord) => IMcpServerWithAuthStore<TTransaction>;
  resolveModelProviderStore: (c: Context, runAsAgent?: AgentRecord) => IModelProviderStore<TTransaction>;
  resolveAgentStore: (c: Context) => IAgentStore<TTransaction>;
  authorizer: Authorizer;
  logger: Logger;
}

async function resolveMemorySource<TTransaction>(
  deps: DataExportDeps<TTransaction>,
  c: Context,
  input: { tenantId: string; subjectId: string },
): Promise<MemoryExportSource> {
  if (configuration.MEMORY_BACKEND === 'markdown') {
    return { kind: 'markdown', markdownDir: configuration.MEMORY_MARKDOWN_DIR };
  }
  const provider = await resolveMemoryProvider({
    mcpServerStore: deps.resolveMcpServerStore(c),
    tokenStore: deps.tokenStore,
    tenantId: input.tenantId,
    clientName: configuration.MCP_DCR_OAUTH_CLIENT_NAME,
    userRef: input.subjectId,
    logger: deps.logger,
  });
  const client: MemoryClient | undefined = createMemoryClient({
    backend: configuration.MEMORY_BACKEND,
    markdownDir: configuration.MEMORY_MARKDOWN_DIR,
    namespace: input.tenantId,
    hindsight:
      provider === undefined
        ? undefined
        : { apiBase: provider.apiBase, bank: provider.bank, headers: provider.headers },
  });
  if (client === undefined) {
    // Memory is part of the export; an instance whose memory backend cannot
    // be read must fail loudly rather than ship an archive without it.
    throw new HTTPException(500, { message: 'The memory backend is unavailable, so the export cannot run.' });
  }
  return { kind: 'client', client };
}

export function createDataExportRouter<TTransaction>(deps: DataExportDeps<TTransaction>): OpenAPIHono {
  const app = new OpenAPIHono();

  app.openapi(exportDataRoute, async c => {
    const requestContext = resolveRequestContext(c);
    const tenantId = requestContext.tenant_id;
    const subjectId = requestContext.subject.id;
    const includeUploads = c.req.valid('query').include_uploads ?? false;

    const mcpServerStore = deps.resolveMcpServerStore(c);
    const modelProviderStore = deps.resolveModelProviderStore(c);
    const managedAgentIds = await resolveManagedAgentIds({
      store: deps.resolveAgentStore(c),
      context: requestContext,
      authorizer: deps.authorizer,
    });
    const secrets = await collectStoredSecrets({
      modelProviderStore,
      mcpServerStore,
      tokenStore: deps.tokenStore,
      tenantId,
      subjectId,
    });
    const memorySource = await resolveMemorySource(deps, c, { tenantId, subjectId });
    const exportedAt = new Date();

    c.header('Content-Type', 'application/zip');
    c.header('Content-Disposition', `attachment; filename="aman-export-${exportedAt.toISOString().slice(0, 10)}.zip"`);
    c.header('Cache-Control', 'private, no-store');

    return stream(c, async streamApi => {
      const writable = new Writable({
        write(chunk: Buffer, _encoding, callback) {
          streamApi.write(new Uint8Array(chunk)).then(
            () => {
              callback();
            },
            (error: unknown) => {
              callback(error instanceof Error ? error : new Error(String(error)));
            },
          );
        },
      });
      try {
        const result = await runDataExport(
          {
            sessionStore: deps.sessionStore,
            personaStore: deps.personaStore,
            personalizationStore: deps.personalizationStore,
            spaceStore: deps.spaceStore,
            scheduleStore: deps.scheduleStore,
            globalSettingsStore: deps.globalSettingsStore,
            sentinelSettingsStore: deps.sentinelSettingsStore,
            turnArtifactStore: deps.turnArtifactStore,
            mcpServerStore,
            memorySource,
            personaKnowledgeDir: configuration.PERSONA_KNOWLEDGE_DIR,
          },
          {
            subject: { tenantId, subjectId, agentIds: managedAgentIds, includeUploads },
            secrets,
            exportedAt,
            appVersion: PACKAGE_VERSION,
            maxBytes: configuration.DATA_EXPORT_MAX_BYTES,
          },
          writable,
        );
        // The zip writer queues into this Writable; end it and wait for the
        // flush so the response stream cannot close ahead of the last bytes.
        writable.end();
        await finished(writable);
        deps.logger.info('Data export completed', {
          subject_id: subjectId,
          tenant_id: tenantId,
          bytes: result.bytesWritten,
          include_uploads: includeUploads,
        });
        try {
          await deps.sentinelAuditStore.record({
            tenant_id: tenantId,
            created_by: subjectId,
            conversation_id: '',
            tier: 1,
            tool_name: 'data_export',
            description: `Exported their data (${String(result.bytesWritten)} bytes${includeUploads ? ', uploaded files included' : ''}).`,
            outcome: 'logged',
            auto_deny_reason: null,
          });
        } catch (auditError) {
          deps.logger.error('Failed to record data export audit row', {
            error: auditError instanceof Error ? auditError.message : String(auditError),
          });
        }
      } catch (error) {
        // The response is already streaming; ending it mid-archive is the
        // visible failure (a truncated zip), and the cap error lands here too.
        deps.logger.error('Data export failed', {
          subject_id: subjectId,
          tenant_id: tenantId,
          error: error instanceof Error ? error.message : String(error),
        });
        writable.destroy();
      }
    });
  });

  return app;
}

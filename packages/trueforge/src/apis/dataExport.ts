/**
 * POST /api/v1/data/export: streams the signed-in user's data export archive.
 *
 * Scope is what the caller created, plus instance-wide memory for administrators. One audit row
 * is recorded per export, completed or failed (who and when, never content). A failed export
 * drops the connection, so a client can never mistake a short archive for a whole one.
 */
import { OpenAPIHono } from '@hono/zod-openapi';
import type { ISessionStore } from '@truefoundry/trueforge-core/agent-session';
import { extractErrorLogFields, type SentinelServices } from '@truefoundry/trueforge-core/core';
import type { Context } from 'hono';
import type { Logger } from 'winston';

import type { Authorizer } from '../auth/authorizer';
import { hasAdminRole, resolveRequestContext } from '../auth/identity';
import configuration from '../config';
import { ExportBodyCancelledError, exportResponseBody } from '../dataExport/exportBody';
import { runDataExport } from '../dataExport/exportService';
import { resolveMemoryExportSource } from '../dataExport/memorySource';
import { normalizeSecrets } from '../dataExport/secretScrub';
import {
  ZipEntryLimitExceededError,
  ZipOutputClosedError,
  ZipSizeCapExceededError,
} from '../dataExport/zipStreamWriter';
import type { IAgentStore } from '../db/agentStore';
import type { IGlobalSettingsStore } from '../db/globalSettingsStore';
import type { IMcpServerWithAuthStore } from '../db/mcpServerStore';
import type { IPersonalizationStore } from '../db/personalizationStore';
import type { IPersonaStore } from '../db/personaStore';
import type { IScheduleStore } from '../db/scheduleStore';
import type { ISentinelAuditStore } from '../db/sentinelAuditStore';
import type { ISentinelSettingsStore } from '../db/sentinelSettingsStore';
import type { SessionCustom, TurnCustom } from '../db/sessionCustom';
import type { ISpaceStore } from '../db/spaceStore';
import type { ITurnArtifactStore } from '../db/turnArtifactStore';
import type { IOAuthTokenStore } from '../mcp/auth/types';
import { PACKAGE_VERSION } from '../packageVersion';
import { exportDataRoute } from '../routes/dataExportRoutes';
import { listManageableAgents } from './agentAccess';

export interface DataExportRouterDeps<TTransaction> {
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
  resolveMcpServerStore: (c?: Context) => IMcpServerWithAuthStore<TTransaction>;
  resolveAgentStore: (c: Context) => IAgentStore<TTransaction>;
  authorizer: Authorizer;
  /** Every secret value this server holds; the same source the outbound secret guard reads. */
  outboundSecrets: SentinelServices['outboundSecrets'];
  logger: Logger;
}

/** A fixed phrase per failure kind: the audit row must never carry content or an error message. */
function failureReason(error: unknown): string {
  if (error instanceof ZipSizeCapExceededError) {
    return 'over the size limit';
  }
  if (error instanceof ZipEntryLimitExceededError) {
    return 'too many files';
  }
  if (error instanceof ZipOutputClosedError || error instanceof ExportBodyCancelledError) {
    return 'the download was cancelled';
  }
  return 'an internal error';
}

export function createDataExportRouter<TTransaction>(deps: DataExportRouterDeps<TTransaction>): OpenAPIHono {
  const app = new OpenAPIHono();

  app.openapi(exportDataRoute, async c => {
    // A cross-site request cannot set this header without a CORS preflight, which is what keeps a
    // page on another origin from starting an export with the user's cookie.
    if (!/^application\/json\b/i.test(c.req.header('content-type') ?? '')) {
      return c.json({ error: { message: 'Unsupported Media Type' } }, 415);
    }
    const requestContext = resolveRequestContext(c);
    const tenantId = requestContext.tenant_id;
    const subjectId = requestContext.subject.id;
    const includeUploads = c.req.valid('json').include_uploads ?? false;

    const mcpServerStore = deps.resolveMcpServerStore(c);
    const agentStore = deps.resolveAgentStore(c);
    const secrets = normalizeSecrets(await deps.outboundSecrets({ tenant_id: tenantId, created_by: subjectId }));
    const memorySource = await resolveMemoryExportSource({
      mcpServerStore,
      tokenStore: deps.tokenStore,
      tenantId,
      subjectId,
      logger: deps.logger,
    });
    const exportedAt = new Date();

    const recordAudit = async (description: string): Promise<void> => {
      try {
        await deps.sentinelAuditStore.record({
          tenant_id: tenantId,
          created_by: subjectId,
          conversation_id: '',
          tier: 1,
          tool_name: 'data_export',
          description,
          outcome: 'logged',
          auto_deny_reason: null,
        });
      } catch (auditError) {
        deps.logger.error('Failed to record data export audit row', extractErrorLogFields(auditError));
      }
    };

    const body = exportResponseBody({
      produce: async out => {
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
              sentinelAuditStore: deps.sentinelAuditStore,
              turnArtifactStore: deps.turnArtifactStore,
              mcpServerStore,
              listAgents: () =>
                listManageableAgents({ store: agentStore, context: requestContext, authorizer: deps.authorizer }),
              memorySource,
              personaKnowledgeDir: configuration.PERSONA_KNOWLEDGE_DIR,
            },
            {
              subject: { tenantId, subjectId, includeUploads, includeInstanceData: hasAdminRole(requestContext) },
              secrets,
              exportedAt,
              appVersion: PACKAGE_VERSION,
              maxBytes: configuration.DATA_EXPORT_MAX_BYTES,
            },
            out,
          );
          deps.logger.info('Data export completed', {
            subject_id: subjectId,
            tenant_id: tenantId,
            bytes: result.bytesWritten,
            redactions: result.redactions,
            include_uploads: includeUploads,
          });
          await recordAudit(
            `Exported their data (${String(result.bytesWritten)} bytes${includeUploads ? ', uploaded files included' : ''}).`,
          );
        } catch (error) {
          deps.logger.error('Data export failed', {
            subject_id: subjectId,
            tenant_id: tenantId,
            ...extractErrorLogFields(error),
          });
          await recordAudit(`Data export failed (${failureReason(error)}).`);
          throw error;
        }
      },
    });

    return c.body(body, 200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="aman-export-${exportedAt.toISOString().slice(0, 10)}.zip"`,
      'Cache-Control': 'private, no-store',
    });
  });

  return app;
}

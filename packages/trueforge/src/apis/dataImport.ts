/**
 * POST /api/v1/data/import: restores an export archive into an empty instance.
 *
 * The signed-in user becomes the owner of everything imported. One audit row
 * is recorded per completed import (who and when, never content).
 */
import { OpenAPIHono } from '@hono/zod-openapi';
import type { ISessionStore } from '@truefoundry/trueforge-core/agent-session';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';

import type { Logger } from 'winston';
import type { Authorizer } from '../auth/authorizer';
import { resolveRequestContext } from '../auth/identity';
import configuration from '../config';
import { DataImportError, runDataImport, type MemoryImportTarget } from '../dataImport/importService';
import type { AgentRecord, IAgentStore } from '../db/agentStore';
import type { IGlobalSettingsStore } from '../db/globalSettingsStore';
import type { IMcpServerWithAuthStore } from '../db/mcpServerStore';
import type { IPersonaStore } from '../db/personaStore';
import type { IPersonalizationStore } from '../db/personalizationStore';
import type { IScheduleStore } from '../db/scheduleStore';
import type { ISentinelAuditStore } from '../db/sentinelAuditStore';
import type { ISentinelSettingsStore } from '../db/sentinelSettingsStore';
import type { SessionCustom, TurnCustom } from '../db/sessionCustom';
import type { ISpaceStore } from '../db/spaceStore';
import type { WithTransaction } from '../db/transaction';
import type { ITurnArtifactStore } from '../db/turnArtifactStore';
import type { IOAuthTokenStore } from '../mcp/auth/types';
import { importDataRoute } from '../routes/dataImportRoutes';
import { createMemoryClient } from '../runtime/memory/createMemoryClient';
import { getSharedEmbeddingModel } from '../runtime/memory/embeddingModel';
import type { MemoryClient } from '../runtime/memory/memoryClient';
import { resolveMemoryProvider } from '../runtime/memory/memoryProvider';
import { resolveManagedAgentIds } from './agentAccess';

export interface DataImportDeps<TTransaction> {
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
  resolveAgentStore: (c: Context) => IAgentStore<TTransaction>;
  withTransaction: WithTransaction<TTransaction>;
  authorizer: Authorizer;
  logger: Logger;
}

/** Reads the request body as bytes, refusing as soon as the running total passes the cap. */
async function readBodyWithCap(c: Context, maxBytes: number): Promise<Buffer> {
  const body: ReadableStream<Uint8Array> | null = c.req.raw.body;
  if (body === null) {
    return Buffer.alloc(0);
  }
  const reader: ReadableStreamDefaultReader<Uint8Array> = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new HTTPException(413, {
        message: `The file is larger than the import limit of ${String(maxBytes)} bytes.`,
      });
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

/** The import target is the install's own default memory backend, whatever the export came from. */
async function resolveMemoryTarget<TTransaction>(
  deps: DataImportDeps<TTransaction>,
  c: Context,
  input: { tenantId: string; subjectId: string },
): Promise<MemoryImportTarget> {
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
    throw new HTTPException(500, { message: 'The memory backend is unavailable, so the import cannot run.' });
  }
  return { kind: 'client', client };
}

export function createDataImportRouter<TTransaction>(deps: DataImportDeps<TTransaction>): OpenAPIHono {
  const app = new OpenAPIHono();

  app.openapi(importDataRoute, async c => {
    const requestContext = resolveRequestContext(c);
    const tenantId = requestContext.tenant_id;
    const subjectId = requestContext.subject.id;
    const maxBytes = configuration.DATA_IMPORT_MAX_BYTES;

    const archive = await readBodyWithCap(c, maxBytes);
    const agentStore = deps.resolveAgentStore(c);
    const managedAgentIds = await resolveManagedAgentIds({
      store: agentStore,
      context: requestContext,
      authorizer: deps.authorizer,
    });
    const memoryTarget = await resolveMemoryTarget(deps, c, { tenantId, subjectId });

    const embeddingModel = getSharedEmbeddingModel({
      modelDir: configuration.MEMORY_EMBEDDINGS_MODEL_DIR,
      log: (message: string) => {
        deps.logger.info(message);
      },
    });
    const embedKnowledgeChunks = async (texts: string[]): Promise<readonly Float32Array[] | null> => {
      const ready = await embeddingModel.ensureReady();
      if (!ready) {
        return null;
      }
      const vectors = await embeddingModel.embedPassages(texts);
      return vectors.map(vector => Float32Array.from(vector));
    };

    try {
      const result = await runDataImport(
        {
          sessionStore: deps.sessionStore,
          personaStore: deps.personaStore,
          personalizationStore: deps.personalizationStore,
          spaceStore: deps.spaceStore,
          scheduleStore: deps.scheduleStore,
          globalSettingsStore: deps.globalSettingsStore,
          sentinelSettingsStore: deps.sentinelSettingsStore,
          turnArtifactStore: deps.turnArtifactStore,
          mcpServerStore: deps.resolveMcpServerStore(c),
          agentStore,
          withTransaction: deps.withTransaction,
          memoryTarget,
          personaKnowledgeDir: configuration.PERSONA_KNOWLEDGE_DIR,
          embedKnowledgeChunks,
        },
        {
          archive,
          subject: {
            tenantId,
            subjectId,
            subjectDisplayName: requestContext.subject.display_name,
            agentIds: managedAgentIds,
          },
          maxBytes,
        },
      );
      deps.logger.info('Data import completed', {
        subject_id: subjectId,
        tenant_id: tenantId,
        chats: result.chats,
        schedules: result.schedules,
      });
      try {
        await deps.sentinelAuditStore.record({
          tenant_id: tenantId,
          created_by: subjectId,
          conversation_id: '',
          tier: 1,
          tool_name: 'data_import',
          description: result.summary,
          outcome: 'logged',
          auto_deny_reason: null,
        });
      } catch (auditError) {
        deps.logger.error('Failed to record data import audit row', {
          error: auditError instanceof Error ? auditError.message : String(auditError),
        });
      }
      return c.json({ data: result }, 200);
    } catch (error) {
      if (error instanceof DataImportError) {
        throw new HTTPException(error.status, { message: error.message, cause: error });
      }
      deps.logger.error('Data import failed', {
        subject_id: subjectId,
        tenant_id: tenantId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new HTTPException(500, { message: 'The import failed. Nothing was imported.', cause: error });
    }
  });

  return app;
}

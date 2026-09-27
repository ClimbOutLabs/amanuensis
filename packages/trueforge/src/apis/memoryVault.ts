/**
 * Memory vault API (mounted at /api/v1/memory/vault).
 *
 * Productizes the markdown memory backend: list, edit, and delete individual
 * memory facts in the tenant's vault namespace, and export/import vaults as
 * JSON. The daily logs stay append-only; edits and deletes are recorded as
 * markers, never rewrites. Only the markdown backend serves the vault;
 * anything else answers 501.
 */
import { randomUUID } from 'node:crypto';
import { OpenAPIHono, type RouteHandler } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { Logger } from 'winston';
import configuration from '../config';
import type { ResolveRequestContext } from '../auth/identity';
import { getEmbeddingSubsystem } from '../runtime/memory/embeddingRetrieval';
import { MarkdownMemoryClient } from '../runtime/memory/markdownMemoryClient';
import {
  sanitizeNamespace,
  stripRetainHeading,
  vaultFilesystemNamespace,
} from '../runtime/memory/markdownMemoryFiles';
import {
  deleteMemoryVaultEntryRoute,
  exportMemoryVaultRoute,
  importMemoryVaultRoute,
  listMemoryVaultEntriesRoute,
  updateMemoryVaultEntryRoute,
} from '../routes/memoryVaultRoutes';

export interface MemoryVaultRouterDeps {
  resolveRequestContext: ResolveRequestContext;
  logger: Logger;
}

/** Upper bound for one vault request's storage work. */
const VAULT_TIMEOUT_MS = 10_000;

function vaultClient(deps: MemoryVaultRouterDeps, tenantId: string): MarkdownMemoryClient | undefined {
  if (configuration.MEMORY_BACKEND !== 'markdown') {
    return undefined;
  }
  return new MarkdownMemoryClient({
    baseDir: configuration.MEMORY_MARKDOWN_DIR,
    namespace: tenantId,
    embeddings: configuration.MEMORY_EMBEDDINGS_ENABLED
      ? getEmbeddingSubsystem({
          baseDir: configuration.MEMORY_MARKDOWN_DIR,
          namespace: sanitizeNamespace(tenantId),
          modelDir: configuration.MEMORY_EMBEDDINGS_MODEL_DIR,
          batchSize: configuration.MEMORY_EMBEDDINGS_BACKFILL_BATCH_SIZE,
          log: (message: string) => deps.logger.info(message),
        })
      : undefined,
  });
}

function markdownBackendRequired(c: Context) {
  return c.json(
    {
      error: {
        message: 'The memory vault needs the markdown memory backend, which this server does not use.',
      },
    },
    501,
  );
}

/** Wire label for a vault namespace query value: blank reads as the shared vault. */
function vaultNamespaceLabel(namespace: string | undefined): string {
  const wire = (namespace ?? '').trim();
  return wire === '' ? 'default' : wire;
}

export function createMemoryVaultRouter(deps: MemoryVaultRouterDeps) {
  const listHandler: RouteHandler<typeof listMemoryVaultEntriesRoute> = async c => {
    const { namespace } = c.req.valid('query');
    const requestContext = deps.resolveRequestContext(c);
    const client = vaultClient(deps, requestContext.tenant_id);
    if (client === undefined) {
      return markdownBackendRequired(c);
    }
    const outcome = await client.listEntries({ namespace: namespace ?? '', timeoutMs: VAULT_TIMEOUT_MS });
    if (!outcome.ok) {
      return c.json({ error: { message: outcome.reason } }, 500);
    }
    return c.json({ data: outcome.entries }, 200);
  };

  const updateHandler: RouteHandler<typeof updateMemoryVaultEntryRoute> = async c => {
    const { entry_id: entryId } = c.req.valid('param');
    const body = c.req.valid('json');
    const requestContext = deps.resolveRequestContext(c);
    const client = vaultClient(deps, requestContext.tenant_id);
    if (client === undefined) {
      return markdownBackendRequired(c);
    }
    const outcome = await client.updateEntry({ entryId, text: body.text, timeoutMs: VAULT_TIMEOUT_MS });
    if (!outcome.ok) {
      if (outcome.code === 'not_found') {
        return c.json({ error: { message: outcome.reason } }, 404);
      }
      return c.json({ error: { message: outcome.reason } }, 500);
    }
    return c.json({ data: outcome.entry }, 200);
  };

  const deleteHandler: RouteHandler<typeof deleteMemoryVaultEntryRoute> = async c => {
    const { entry_id: entryId } = c.req.valid('param');
    const requestContext = deps.resolveRequestContext(c);
    const client = vaultClient(deps, requestContext.tenant_id);
    if (client === undefined) {
      return markdownBackendRequired(c);
    }
    const outcome = await client.deleteEntry({ entryId, timeoutMs: VAULT_TIMEOUT_MS });
    if (!outcome.ok) {
      if (outcome.code === 'not_found') {
        return c.json({ error: { message: outcome.reason } }, 404);
      }
      return c.json({ error: { message: outcome.reason } }, 500);
    }
    return c.json({}, 200);
  };

  const exportHandler: RouteHandler<typeof exportMemoryVaultRoute> = async c => {
    const { namespace } = c.req.valid('query');
    const requestContext = deps.resolveRequestContext(c);
    const client = vaultClient(deps, requestContext.tenant_id);
    if (client === undefined) {
      return markdownBackendRequired(c);
    }
    const outcome = await client.listEntries({ namespace: namespace ?? '', timeoutMs: VAULT_TIMEOUT_MS });
    if (!outcome.ok) {
      return c.json({ error: { message: outcome.reason } }, 500);
    }
    return c.json(
      {
        data: {
          namespace: vaultNamespaceLabel(namespace),
          exported_at: new Date().toISOString(),
          entries: outcome.entries,
        },
      },
      200,
    );
  };

  const importHandler: RouteHandler<typeof importMemoryVaultRoute> = async c => {
    const body = c.req.valid('json');
    const requestContext = deps.resolveRequestContext(c);
    if (configuration.MEMORY_BACKEND !== 'markdown') {
      return markdownBackendRequired(c);
    }
    const tenantNamespace = sanitizeNamespace(requestContext.tenant_id);
    const filesystemNamespace = vaultFilesystemNamespace(tenantNamespace, body.namespace);
    // Bound to the target vault namespace so the import lands in its daily logs.
    // Shared-vault imports get the embedding subsystem so imported facts become
    // meaning-searchable right away, the same as vault edits; other namespaces
    // have no embedding subsystem and converge on the next warm.
    const importClient = new MarkdownMemoryClient({
      baseDir: configuration.MEMORY_MARKDOWN_DIR,
      namespace: filesystemNamespace,
      embeddings:
        configuration.MEMORY_EMBEDDINGS_ENABLED && filesystemNamespace === tenantNamespace
          ? getEmbeddingSubsystem({
              baseDir: configuration.MEMORY_MARKDOWN_DIR,
              namespace: tenantNamespace,
              modelDir: configuration.MEMORY_EMBEDDINGS_MODEL_DIR,
              batchSize: configuration.MEMORY_EMBEDDINGS_BACKFILL_BATCH_SIZE,
              log: (message: string) => deps.logger.info(message),
            })
          : undefined,
    });
    const now = new Date().toISOString();
    const items = body.entries.map(entry => {
      let timestamp = now;
      if (entry.timestamp !== undefined) {
        const parsed = new Date(entry.timestamp);
        if (!Number.isNaN(parsed.getTime())) {
          timestamp = parsed.toISOString();
        }
      }
      // Exported text carries retain's `## <timestamp>` heading; retain adds its
      // own, so strip the stale one first instead of stacking a phantom entry.
      return { content: stripRetainHeading(entry.text), timestamp, document_id: randomUUID() };
    });
    const outcome = await importClient.retain({
      items,
      operationId: randomUUID(),
      timeoutMs: VAULT_TIMEOUT_MS,
    });
    if (!outcome.ok) {
      return c.json({ error: { message: outcome.reason ?? 'The vault import failed.' } }, 500);
    }
    return c.json({ data: { namespace: vaultNamespaceLabel(body.namespace), imported: items.length } }, 201);
  };

  const router = new OpenAPIHono();
  // Static paths first: `/{entry_id}` would also match `/export` and `/import`.
  router.openapi(listMemoryVaultEntriesRoute, listHandler);
  router.openapi(exportMemoryVaultRoute, exportHandler);
  router.openapi(importMemoryVaultRoute, importHandler);
  router.openapi(updateMemoryVaultEntryRoute, updateHandler);
  router.openapi(deleteMemoryVaultEntryRoute, deleteHandler);
  return router;
}

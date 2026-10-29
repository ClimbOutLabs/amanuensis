/**
 * Memory vault API (mounted at /api/v1/memory/vault).
 *
 * Productizes the markdown memory backend: list, edit, and delete individual
 * memory facts across tenant-scoped vault namespaces, export/import vaults as
 * JSON, and store the per-persona sharing config. The daily logs stay
 * append-only; edits and deletes are recorded as markers, never rewrites.
 * Only the markdown backend serves the vault; anything else answers 501.
 */
import { OpenAPIHono, type RouteHandler } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { randomUUID } from 'node:crypto';
import type { Logger } from 'winston';
import type { ResolveRequestContext } from '../auth/identity';
import configuration from '../config';
import {
  deleteMemoryVaultEntryRoute,
  exportMemoryVaultRoute,
  getMemoryVaultSharingRoute,
  getMemoryVaultSummaryStatusRoute,
  importMemoryVaultRoute,
  listMemoryVaultEntriesRoute,
  putMemoryVaultSharingRoute,
  updateMemoryVaultEntryRoute,
} from '../routes/memoryVaultRoutes';
import { getEmbeddingSubsystem } from '../runtime/memory/embeddingRetrieval';
import { MarkdownMemoryClient } from '../runtime/memory/markdownMemoryClient';
import {
  readVaultSharing,
  sanitizeNamespace,
  vaultFilesystemNamespace,
  withHiddenContext,
  writeVaultSharing,
  type VaultSharing,
} from '../runtime/memory/markdownMemoryFiles';
import type { MemoryVaultEntry as VaultEntry } from '../runtime/memory/memoryClient';
import type { MemoryVaultEntry } from '../schemas/memoryVault';

export interface MemoryVaultRouterDeps {
  resolveRequestContext: ResolveRequestContext;
  logger: Logger;
}

/** Upper bound for one vault request's storage work. */
const VAULT_TIMEOUT_MS = 10_000;

const MAX_SHARING_PERSONAS = 100;
const MAX_SHARING_NAMESPACES = 100;

/** The wire shape of an entry: the internal id it was filed under stays on the server. */
function wireEntry({ id, text, timestamp, persona }: VaultEntry): MemoryVaultEntry {
  return { id, text, timestamp, persona };
}

/** An exported entry carries its internal id as the closing line, the same shape the daily logs hold. */
function exportedEntry({ id, text, timestamp, persona, context }: VaultEntry): MemoryVaultEntry {
  return { id, text: withHiddenContext({ text, context }), timestamp, persona };
}

function vaultClient(deps: MemoryVaultRouterDeps, tenantId: string): MarkdownMemoryClient | undefined {
  if (configuration.MEMORY_BACKEND !== 'markdown') {
    return undefined;
  }
  return new MarkdownMemoryClient({
    baseDir: configuration.MEMORY_MARKDOWN_DIR,
    namespace: tenantId,
    embeddings: configuration.MEMORY_EMBEDDINGS_ENABLED
      ? namespace =>
          getEmbeddingSubsystem({
            baseDir: configuration.MEMORY_MARKDOWN_DIR,
            namespace,
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

/**
 * Validates and normalizes a sharing payload. Returns the error message, or the
 * normalized shares when valid. Keys are persona ids (what the vault UI saves) or
 * persona names; turn-time recall honors both.
 */
function normalizeSharing(shares: Record<string, string[]>): { shares: Record<string, string[]> } | { error: string } {
  const entries = Object.entries(shares);
  if (entries.length > MAX_SHARING_PERSONAS) {
    return { error: `At most ${String(MAX_SHARING_PERSONAS)} personas can share vaults.` };
  }
  const normalized: Record<string, string[]> = {};
  for (const [persona, namespaces] of entries) {
    const name = persona.trim();
    if (name === '' || name.length > 64) {
      return { error: 'Persona ids or names must be 1 to 64 characters.' };
    }
    if (!Array.isArray(namespaces) || namespaces.length > MAX_SHARING_NAMESPACES) {
      return { error: `Persona "${name}" can read at most ${String(MAX_SHARING_NAMESPACES)} namespaces.` };
    }
    const seen = new Set<string>();
    for (const namespace of namespaces) {
      if (typeof namespace !== 'string') {
        return { error: `Persona "${name}" has an invalid namespace.` };
      }
      const trimmed = namespace.trim();
      if (trimmed === '' || trimmed.length > 128) {
        return { error: `Persona "${name}" has a namespace that must be 1 to 128 characters.` };
      }
      seen.add(trimmed);
    }
    normalized[name] = [...seen];
  }
  return { shares: normalized };
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
    return c.json({ data: outcome.entries.map(wireEntry) }, 200);
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
          entries: outcome.entries.map(exportedEntry),
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
    const importClient = new MarkdownMemoryClient({
      baseDir: configuration.MEMORY_MARKDOWN_DIR,
      namespace: filesystemNamespace,
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
      return { content: entry.text, timestamp, document_id: randomUUID() };
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

  const getSharingHandler: RouteHandler<typeof getMemoryVaultSharingRoute> = async c => {
    const requestContext = deps.resolveRequestContext(c);
    if (configuration.MEMORY_BACKEND !== 'markdown') {
      return markdownBackendRequired(c);
    }
    const sharing = await readVaultSharing({
      baseDir: configuration.MEMORY_MARKDOWN_DIR,
      tenantNamespace: sanitizeNamespace(requestContext.tenant_id),
    });
    return c.json({ data: { shares: sharing.shares } }, 200);
  };

  const putSharingHandler: RouteHandler<typeof putMemoryVaultSharingRoute> = async c => {
    const body = c.req.valid('json');
    const requestContext = deps.resolveRequestContext(c);
    if (configuration.MEMORY_BACKEND !== 'markdown') {
      return markdownBackendRequired(c);
    }
    const normalized = normalizeSharing(body.shares);
    if ('error' in normalized) {
      return c.json({ error: { message: normalized.error } }, 400);
    }
    const sharing: VaultSharing = { version: 1, shares: normalized.shares };
    await writeVaultSharing({
      baseDir: configuration.MEMORY_MARKDOWN_DIR,
      tenantNamespace: sanitizeNamespace(requestContext.tenant_id),
      sharing,
    });
    return c.json({ data: { shares: sharing.shares } }, 200);
  };

  const summaryStatusHandler: RouteHandler<typeof getMemoryVaultSummaryStatusRoute> = async c => {
    const { namespace } = c.req.valid('query');
    const requestContext = deps.resolveRequestContext(c);
    const client = vaultClient(deps, requestContext.tenant_id);
    if (client === undefined) {
      return markdownBackendRequired(c);
    }
    const summaryPending = await client.summaryPending({ namespace: namespace ?? '' });
    return c.json({ data: { summary_pending: summaryPending } }, 200);
  };

  const router = new OpenAPIHono();
  // Static paths first: `/{entry_id}` would also match `/export`, `/import`, `/sharing`.
  router.openapi(listMemoryVaultEntriesRoute, listHandler);
  router.openapi(exportMemoryVaultRoute, exportHandler);
  router.openapi(importMemoryVaultRoute, importHandler);
  router.openapi(getMemoryVaultSharingRoute, getSharingHandler);
  router.openapi(putMemoryVaultSharingRoute, putSharingHandler);
  router.openapi(getMemoryVaultSummaryStatusRoute, summaryStatusHandler);
  router.openapi(updateMemoryVaultEntryRoute, updateHandler);
  router.openapi(deleteMemoryVaultEntryRoute, deleteHandler);
  return router;
}

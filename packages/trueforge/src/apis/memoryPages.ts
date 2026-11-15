/**
 * Memory pages API (mounted at /api/v1/memory/pages).
 *
 * Lists, shows, edits and deletes the pages Aman keeps for people and matters, settles unconfirmed lines and
 * undoes recent changes.
 */
import { OpenAPIHono, type RouteHandler } from '@hono/zod-openapi';
import { execFileRunner } from '@truefoundry/trueforge-core/core';
import type { Context } from 'hono';
import type { Logger } from 'winston';
import type { ResolveRequestContext } from '../auth/identity';
import configuration from '../config';
import {
  confirmMemoryPageLineRoute,
  deleteMemoryPageRoute,
  dismissMemoryPageDisagreementRoute,
  dismissMemoryPageLineRoute,
  getMemoryPageRoute,
  listMemoryPageChangesRoute,
  listMemoryPagesRoute,
  undoMemoryPageChangeRoute,
  updateMemoryPageRoute,
} from '../routes/memoryPagesRoutes';
import { localDay } from '../runtime/memory/localDay';
import { namespaceDirFor, sanitizeNamespace, vaultFilesystemNamespace } from '../runtime/memory/markdownMemoryFiles';
import type { PageChangeOptions } from '../runtime/memory/memoryPageWriter';
import {
  confirmPageLine,
  deletePageFile,
  dismissPageDisagreement,
  dismissPageLine,
  listPageChanges,
  listPagesForScreen,
  readPageForScreen,
  savePageEdit,
  undoPageChange,
  type Refusal,
} from '../runtime/memory/memoryPagesScreen';

export interface MemoryPagesRouterDeps {
  resolveRequestContext: ResolveRequestContext;
  logger: Logger;
}

const STATUS_OF_REFUSAL = { not_found: 404, invalid: 400, conflict: 409 } as const;

/** The vault folder for a tenant and wire namespace. */
function pagesVaultDir({ tenantId, namespace }: { tenantId: string; namespace: string | undefined }) {
  return namespaceDirFor(
    configuration.MEMORY_MARKDOWN_DIR,
    vaultFilesystemNamespace(sanitizeNamespace(tenantId), namespace),
  );
}

function noSuchPage(c: Context) {
  return c.json({ error: { message: 'There is no page with that name. Reload the list.' } }, 404);
}

export function createMemoryPagesRouter(deps: MemoryPagesRouterDeps) {
  /** The vault and the options a change needs. */
  function scope(c: Context, namespace: string | undefined): PageChangeOptions {
    const vaultDir = pagesVaultDir({ tenantId: deps.resolveRequestContext(c).tenant_id, namespace });
    return {
      vaultDir,
      runner: execFileRunner,
      today: localDay({ instant: new Date() }).date,
      logger: deps.logger,
    };
  }

  function refusal(c: Context, outcome: Refusal) {
    return c.json({ error: { message: outcome.message } }, STATUS_OF_REFUSAL[outcome.code]);
  }

  const listHandler: RouteHandler<typeof listMemoryPagesRoute> = async c => {
    const options = scope(c, c.req.valid('query').namespace);
    return c.json({ data: await listPagesForScreen(options.vaultDir) }, 200);
  };

  const changesHandler: RouteHandler<typeof listMemoryPageChangesRoute> = async c => {
    const options = scope(c, c.req.valid('query').namespace);
    return c.json({ data: await listPageChanges({ vaultDir: options.vaultDir, runner: options.runner }) }, 200);
  };

  const undoHandler: RouteHandler<typeof undoMemoryPageChangeRoute> = async c => {
    const options = scope(c, c.req.valid('query').namespace);
    const outcome = await undoPageChange({ options, changeId: c.req.valid('param').change_id });
    return outcome.ok ? c.json({ data: outcome.value }, 200) : refusal(c, outcome);
  };

  const getHandler: RouteHandler<typeof getMemoryPageRoute> = async c => {
    const { kind, slug } = c.req.valid('param');
    const options = scope(c, c.req.valid('query').namespace);
    const page = await readPageForScreen({ vaultDir: options.vaultDir, kind, slug });
    return page === undefined ? noSuchPage(c) : c.json({ data: page }, 200);
  };

  const updateHandler: RouteHandler<typeof updateMemoryPageRoute> = async c => {
    const { kind, slug } = c.req.valid('param');
    const options = scope(c, c.req.valid('query').namespace);
    const { text, version } = c.req.valid('json');
    const outcome = await savePageEdit({ options, kind, slug, text, version });
    return outcome.ok ? c.json({ data: outcome.value }, 200) : refusal(c, outcome);
  };

  const deleteHandler: RouteHandler<typeof deleteMemoryPageRoute> = async c => {
    const { kind, slug } = c.req.valid('param');
    const options = scope(c, c.req.valid('query').namespace);
    const outcome = await deletePageFile({ options, kind, slug });
    return outcome.ok ? c.json({}, 200) : refusal(c, outcome);
  };

  const confirmHandler: RouteHandler<typeof confirmMemoryPageLineRoute> = async c => {
    const { kind, slug, fact_id: factId } = c.req.valid('param');
    const options = scope(c, c.req.valid('query').namespace);
    const body = c.req.valid('json');
    const outcome = await confirmPageLine({ options, kind, slug, factId, section: body.section });
    return outcome.ok ? c.json({ data: outcome.value }, 200) : refusal(c, outcome);
  };

  const dismissHandler: RouteHandler<typeof dismissMemoryPageLineRoute> = async c => {
    const { kind, slug, fact_id: factId } = c.req.valid('param');
    const options = scope(c, c.req.valid('query').namespace);
    const outcome = await dismissPageLine({ options, kind, slug, factId });
    return outcome.ok ? c.json({ data: outcome.value }, 200) : refusal(c, outcome);
  };

  const dismissDisagreementHandler: RouteHandler<typeof dismissMemoryPageDisagreementRoute> = async c => {
    const { kind, slug, disagreement_id: disagreementId } = c.req.valid('param');
    const options = scope(c, c.req.valid('query').namespace);
    const outcome = await dismissPageDisagreement({ vaultDir: options.vaultDir, kind, slug, disagreementId });
    return outcome.ok ? c.json({ data: outcome.value }, 200) : refusal(c, outcome);
  };

  const router = new OpenAPIHono();
  router.openapi(listMemoryPagesRoute, listHandler);
  router.openapi(listMemoryPageChangesRoute, changesHandler);
  router.openapi(undoMemoryPageChangeRoute, undoHandler);
  router.openapi(getMemoryPageRoute, getHandler);
  router.openapi(updateMemoryPageRoute, updateHandler);
  router.openapi(deleteMemoryPageRoute, deleteHandler);
  router.openapi(confirmMemoryPageLineRoute, confirmHandler);
  router.openapi(dismissMemoryPageLineRoute, dismissHandler);
  router.openapi(dismissMemoryPageDisagreementRoute, dismissDisagreementHandler);
  return router;
}

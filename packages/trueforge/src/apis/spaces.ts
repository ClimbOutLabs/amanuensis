import { OpenAPIHono, type RouteHandler } from '@hono/zod-openapi';
import { ulid } from 'ulid';
import type { ResolveRequestContext } from '../auth/identity';
import {
  SpaceAggregateRevisionConflictError,
  SpaceNotFoundError,
  SpaceRevisionConflictError,
  SpaceRevisionNotFoundError,
  type ISpaceStore,
  type SpaceRecord,
} from '../db/spaceStore';
import {
  createSpaceRoute,
  deleteSpaceRoute,
  getSpaceRoute,
  listSpacesRoute,
  revertSpaceRoute,
  updateSpaceRoute,
} from '../routes/spaceRoutes';
import type { Space } from '../schemas/space';
import { TENANT_ID } from './sessions';

function toSpaceWire({ record, folder_id }: { record: SpaceRecord; folder_id: string | null }): Space {
  return {
    id: record.id,
    name: record.name,
    purpose: record.purpose,
    status: record.status,
    body: record.body,
    format: record.format,
    folder_id,
    revision: record.revision,
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
}

function isSpaceRevisionConflict(
  error: unknown,
): error is SpaceRevisionConflictError | SpaceAggregateRevisionConflictError {
  return error instanceof SpaceRevisionConflictError || error instanceof SpaceAggregateRevisionConflictError;
}

/**
 * Spaces are ordered by a mutable field (name), so a create/update between pages can shift
 * records across the numeric offset boundary and duplicate or omit rows. When the caller supplies
 * `expected_aggregate_revision` on a continuation (`offset` set) and the collection's current
 * aggregate revision no longer matches it, reject instead of silently returning a possibly
 * corrupted page.
 */
function pagedListAggregateRevisionConflictMessage(
  query: { readonly offset: number | undefined; readonly expected_aggregate_revision: number | undefined },
  aggregate_revision: number,
): string | undefined {
  if (
    query.offset === undefined ||
    query.expected_aggregate_revision === undefined ||
    query.expected_aggregate_revision === aggregate_revision
  ) {
    return undefined;
  }
  return `The collection changed since aggregate_revision ${String(query.expected_aggregate_revision)}. Restart the read from offset 0 to avoid duplicate or omitted records.`;
}

export interface SpacesRouterDeps<TTransaction> {
  spaceStore: ISpaceStore<TTransaction>;
  resolveRequestContext: ResolveRequestContext;
}

/** Spaces CRUD (mounted at /api/v1/spaces). */
export function createSpacesRouter<TTransaction>(deps: SpacesRouterDeps<TTransaction>) {
  const folderIdsBySpace = async (created_by: string, records: readonly SpaceRecord[]) => {
    const assignments = await deps.spaceStore.listSpaceFolderAssignments({
      tenant_id: TENANT_ID,
      created_by,
      space_ids: records.map(record => record.id),
    });
    return new Map(assignments.map(assignment => [assignment.space_id, assignment.folder_id]));
  };

  const toWire = async (created_by: string, record: SpaceRecord) =>
    toSpaceWire({ record, folder_id: (await folderIdsBySpace(created_by, [record])).get(record.id) ?? null });

  const listHandler: RouteHandler<typeof listSpacesRoute> = async c => {
    const created_by = deps.resolveRequestContext(c).subject.id;
    const query = c.req.valid('query');
    const { limit, offset } = query;
    const result = await deps.spaceStore.listSpacesWithAggregate({
      tenant_id: TENANT_ID,
      created_by,
      status: undefined,
      limit,
      offset,
    });
    const conflictMessage = pagedListAggregateRevisionConflictMessage(
      { offset: query.offset, expected_aggregate_revision: query.expected_aggregate_revision },
      result.aggregate_revision,
    );
    if (conflictMessage !== undefined) {
      return c.json({ error: { message: conflictMessage } }, 409);
    }
    const folderIds = await folderIdsBySpace(created_by, result.records);
    return c.json(
      {
        data: {
          spaces: result.records.map(record => toSpaceWire({ record, folder_id: folderIds.get(record.id) ?? null })),
          aggregate_revision: result.aggregate_revision,
        },
        pagination: { has_more: result.has_more, next_offset: result.next_offset },
      },
      200,
    );
  };

  const createHandler: RouteHandler<typeof createSpaceRoute> = async c => {
    const { space, expected_aggregate_revision } = c.req.valid('json');
    const created_by = deps.resolveRequestContext(c).subject.id;
    try {
      const result = await deps.spaceStore.createSpace({
        tenant_id: TENANT_ID,
        created_by,
        id: ulid().toLowerCase(),
        ...space,
        expected_aggregate_revision,
      });
      return c.json(
        {
          data: {
            space: toSpaceWire({ record: result.record, folder_id: null }),
            aggregate_revision: result.aggregate_revision,
          },
        },
        201,
      );
    } catch (error) {
      if (error instanceof SpaceAggregateRevisionConflictError) {
        return c.json({ error: { message: error.message } }, 409);
      }
      throw error;
    }
  };

  const getHandler: RouteHandler<typeof getSpaceRoute> = async c => {
    const { space_id } = c.req.valid('param');
    const { revision } = c.req.valid('query');
    const created_by = deps.resolveRequestContext(c).subject.id;
    const space =
      revision === undefined
        ? await deps.spaceStore.getSpace({ tenant_id: TENANT_ID, created_by, space_id })
        : await deps.spaceStore.getSpaceRevision({ tenant_id: TENANT_ID, created_by, space_id, revision });
    if (space === undefined) {
      return c.json({ error: { message: `Space not found: ${space_id}` } }, 404);
    }
    return c.json({ data: await toWire(created_by, space) }, 200);
  };

  const updateHandler: RouteHandler<typeof updateSpaceRoute> = async c => {
    const { space_id } = c.req.valid('param');
    const { space, expected_revision, expected_aggregate_revision } = c.req.valid('json');
    const created_by = deps.resolveRequestContext(c).subject.id;
    try {
      const result = await deps.spaceStore.updateSpace({
        tenant_id: TENANT_ID,
        created_by,
        space_id,
        ...space,
        expected_revision,
        expected_aggregate_revision,
      });
      return c.json(
        { data: { space: await toWire(created_by, result.record), aggregate_revision: result.aggregate_revision } },
        200,
      );
    } catch (error) {
      if (error instanceof SpaceNotFoundError) {
        return c.json({ error: { message: error.message } }, 404);
      }
      if (isSpaceRevisionConflict(error)) {
        return c.json({ error: { message: error.message } }, 409);
      }
      throw error;
    }
  };

  const deleteHandler: RouteHandler<typeof deleteSpaceRoute> = async c => {
    const { space_id } = c.req.valid('param');
    const { expected_revision } = c.req.valid('query');
    const created_by = deps.resolveRequestContext(c).subject.id;
    try {
      await deps.spaceStore.deleteSpace({ tenant_id: TENANT_ID, created_by, space_id, expected_revision });
      return c.json({}, 200);
    } catch (error) {
      if (error instanceof SpaceNotFoundError) {
        return c.json({ error: { message: error.message } }, 404);
      }
      if (isSpaceRevisionConflict(error)) {
        return c.json({ error: { message: error.message } }, 409);
      }
      throw error;
    }
  };

  const revertHandler: RouteHandler<typeof revertSpaceRoute> = async c => {
    const { space_id } = c.req.valid('param');
    const { revision, expected_revision, expected_aggregate_revision } = c.req.valid('json');
    const created_by = deps.resolveRequestContext(c).subject.id;
    try {
      const result = await deps.spaceStore.revertSpace({
        tenant_id: TENANT_ID,
        created_by,
        space_id,
        revision,
        expected_revision,
        expected_aggregate_revision,
      });
      return c.json(
        { data: { space: await toWire(created_by, result.record), aggregate_revision: result.aggregate_revision } },
        200,
      );
    } catch (error) {
      if (error instanceof SpaceNotFoundError || error instanceof SpaceRevisionNotFoundError) {
        return c.json({ error: { message: error.message } }, 404);
      }
      if (isSpaceRevisionConflict(error)) {
        return c.json({ error: { message: error.message } }, 409);
      }
      throw error;
    }
  };

  const router = new OpenAPIHono();
  router.openapi(listSpacesRoute, listHandler);
  router.openapi(createSpaceRoute, createHandler);
  router.openapi(getSpaceRoute, getHandler);
  router.openapi(updateSpaceRoute, updateHandler);
  router.openapi(revertSpaceRoute, revertHandler);
  router.openapi(deleteSpaceRoute, deleteHandler);
  return router;
}

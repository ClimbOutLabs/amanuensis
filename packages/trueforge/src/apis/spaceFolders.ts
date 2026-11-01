import { OpenAPIHono, type RouteHandler } from '@hono/zod-openapi';
import { ulid } from 'ulid';
import type { ResolveRequestContext } from '../auth/identity';
import {
  SpaceFolderNotFoundError,
  SpaceNotFoundError,
  type ISpaceStore,
  type SpaceFolderRecord,
} from '../db/spaceStore';
import {
  clearSpaceFolderRoute,
  createSpaceFolderRoute,
  deleteSpaceFolderRoute,
  listSpaceFoldersRoute,
  putSpaceFolderRoute,
  setSpaceFolderRoute,
} from '../routes/spaceFolderRoutes';
import type { SpaceFolder } from '../schemas/spaceFolder';
import { TENANT_ID } from './sessions';

function toWireFolder(record: SpaceFolderRecord): SpaceFolder {
  return { id: record.id, name: record.name, created_at: record.created_at, updated_at: record.updated_at };
}

export interface SpaceFoldersRouterDeps<TTransaction> {
  spaceStore: ISpaceStore<TTransaction>;
  resolveRequestContext: ResolveRequestContext;
}

/** Space folder CRUD (mounted at /api/v1/space-folders). */
export function createSpaceFoldersRouter<TTransaction>(deps: SpaceFoldersRouterDeps<TTransaction>) {
  const listHandler: RouteHandler<typeof listSpaceFoldersRoute> = async c => {
    const created_by = deps.resolveRequestContext(c).subject.id;
    const folders = await deps.spaceStore.listSpaceFolders({ tenant_id: TENANT_ID, created_by });
    return c.json({ data: folders.map(toWireFolder) }, 200);
  };

  const createHandler: RouteHandler<typeof createSpaceFolderRoute> = async c => {
    const created_by = deps.resolveRequestContext(c).subject.id;
    const folder = await deps.spaceStore.createSpaceFolder({
      tenant_id: TENANT_ID,
      created_by,
      id: ulid().toLowerCase(),
      name: c.req.valid('json').name,
    });
    return c.json({ data: toWireFolder(folder) }, 201);
  };

  const putHandler: RouteHandler<typeof putSpaceFolderRoute> = async c => {
    const created_by = deps.resolveRequestContext(c).subject.id;
    const { folder_id } = c.req.valid('param');
    try {
      const folder = await deps.spaceStore.updateSpaceFolder({
        tenant_id: TENANT_ID,
        created_by,
        folder_id,
        name: c.req.valid('json').name,
      });
      return c.json({ data: toWireFolder(folder) }, 200);
    } catch (error) {
      if (error instanceof SpaceFolderNotFoundError) {
        return c.json({ error: { message: error.message } }, 404);
      }
      throw error;
    }
  };

  const deleteHandler: RouteHandler<typeof deleteSpaceFolderRoute> = async c => {
    const created_by = deps.resolveRequestContext(c).subject.id;
    const { folder_id } = c.req.valid('param');
    await deps.spaceStore.deleteSpaceFolder({ tenant_id: TENANT_ID, created_by, folder_id });
    return c.json({}, 200);
  };

  const router = new OpenAPIHono();
  router.openapi(listSpaceFoldersRoute, listHandler);
  router.openapi(createSpaceFolderRoute, createHandler);
  router.openapi(putSpaceFolderRoute, putHandler);
  router.openapi(deleteSpaceFolderRoute, deleteHandler);
  return router;
}

/** Moving a space in or out of a folder (mounted at /api/v1/spaces). */
export function createSpaceFolderAssignmentsRouter<TTransaction>(deps: SpaceFoldersRouterDeps<TTransaction>) {
  const move = async (input: { space_id: string; folder_id: string | null; created_by: string }) => {
    try {
      await deps.spaceStore.setSpaceFolder({ tenant_id: TENANT_ID, ...input });
      return undefined;
    } catch (error) {
      if (error instanceof SpaceNotFoundError || error instanceof SpaceFolderNotFoundError) {
        return error.message;
      }
      throw error;
    }
  };

  const setHandler: RouteHandler<typeof setSpaceFolderRoute> = async c => {
    const created_by = deps.resolveRequestContext(c).subject.id;
    const { space_id } = c.req.valid('param');
    const notFound = await move({ space_id, folder_id: c.req.valid('json').folder_id, created_by });
    return notFound === undefined ? c.json({}, 200) : c.json({ error: { message: notFound } }, 404);
  };

  const clearHandler: RouteHandler<typeof clearSpaceFolderRoute> = async c => {
    const created_by = deps.resolveRequestContext(c).subject.id;
    const { space_id } = c.req.valid('param');
    const notFound = await move({ space_id, folder_id: null, created_by });
    return notFound === undefined ? c.json({}, 200) : c.json({ error: { message: notFound } }, 404);
  };

  const router = new OpenAPIHono();
  router.openapi(setSpaceFolderRoute, setHandler);
  router.openapi(clearSpaceFolderRoute, clearHandler);
  return router;
}

import { OpenAPIHono, type RouteHandler } from '@hono/zod-openapi';
import type { ISessionStore, SessionFolderRecord } from '@truefoundry/trueforge-core/agent-session';
import { SessionFolderNotFoundError, SessionNotFoundError } from '@truefoundry/trueforge-core/agent-session';
import { ulid } from 'ulid';
import type { ResolveRequestContext } from '../auth/identity';
import type { SessionCustom, TurnCustom } from '../db/sessionCustom';
import {
  clearSessionFolderRoute,
  createSessionFolderRoute,
  deleteSessionFolderRoute,
  listSessionFoldersRoute,
  putSessionFolderRoute,
  setSessionFolderRoute,
} from '../routes/sessionFolderRoutes';
import type { SessionFolder } from '../schemas/sessionFolder';
import { checkSessionAccess, FORBIDDEN_SESSION_ACCESS, TENANT_ID } from './sessions';

function toWireFolder(record: SessionFolderRecord): SessionFolder {
  return {
    id: record.folder_id,
    name: record.name,
    created_at: record.created_at.toISOString(),
    updated_at: record.updated_at.toISOString(),
  };
}

export function createSessionFoldersRouter(deps: {
  sessionStore: ISessionStore<SessionCustom, TurnCustom>;
  resolveRequestContext: ResolveRequestContext;
}) {
  const listHandler: RouteHandler<typeof listSessionFoldersRoute> = async c => {
    const requestContext = deps.resolveRequestContext(c);
    const folders = await deps.sessionStore.listSessionFolders({
      tenant_id: TENANT_ID,
      created_by: requestContext.subject.id,
    });
    return c.json({ data: folders.map(toWireFolder) }, 200);
  };

  const createHandler: RouteHandler<typeof createSessionFolderRoute> = async c => {
    const requestContext = deps.resolveRequestContext(c);
    const body = c.req.valid('json');
    const folder = await deps.sessionStore.createSessionFolder({
      tenant_id: TENANT_ID,
      folder_id: ulid().toLowerCase(),
      created_by: requestContext.subject.id,
      name: body.name,
    });
    return c.json({ data: toWireFolder(folder) }, 201);
  };

  const putHandler: RouteHandler<typeof putSessionFolderRoute> = async c => {
    const requestContext = deps.resolveRequestContext(c);
    const { folder_id: folderId } = c.req.valid('param');
    const folder = await deps.sessionStore.updateSessionFolder({
      tenant_id: TENANT_ID,
      folder_id: folderId,
      created_by: requestContext.subject.id,
      name: c.req.valid('json').name,
    });
    if (folder === undefined) {
      return c.json({ error: { message: `Session folder not found: ${folderId}` } }, 404);
    }
    return c.json({ data: toWireFolder(folder) }, 200);
  };

  const deleteHandler: RouteHandler<typeof deleteSessionFolderRoute> = async c => {
    const requestContext = deps.resolveRequestContext(c);
    const { folder_id: folderId } = c.req.valid('param');
    await deps.sessionStore.deleteSessionFolder({
      tenant_id: TENANT_ID,
      folder_id: folderId,
      created_by: requestContext.subject.id,
    });
    return c.json({}, 200);
  };

  const router = new OpenAPIHono();
  router.openapi(listSessionFoldersRoute, listHandler);
  router.openapi(createSessionFolderRoute, createHandler);
  router.openapi(putSessionFolderRoute, putHandler);
  router.openapi(deleteSessionFolderRoute, deleteHandler);
  return router;
}

export function createSessionFolderAssignmentsRouter(deps: {
  sessionStore: ISessionStore<SessionCustom, TurnCustom>;
  resolveRequestContext: ResolveRequestContext;
}) {
  const requireOwnedSession = async (sessionId: string, userRef: string) => {
    const session = await deps.sessionStore.getSession({ tenant_id: TENANT_ID, session_id: sessionId });
    if (session === undefined) {
      return { error: 'not_found' as const };
    }
    if (!checkSessionAccess({ userRef, createdBy: session.created_by_subject.subject_id })) {
      return { error: 'forbidden' as const };
    }
    return { error: null };
  };

  const setHandler: RouteHandler<typeof setSessionFolderRoute> = async c => {
    const requestContext = deps.resolveRequestContext(c);
    const { session_id: sessionId } = c.req.valid('param');
    const ownership = await requireOwnedSession(sessionId, requestContext.subject.id);
    if (ownership.error === 'not_found') {
      return c.json({ error: { message: `Session not found: ${sessionId}` } }, 404);
    }
    if (ownership.error === 'forbidden') {
      return c.json({ error: { message: FORBIDDEN_SESSION_ACCESS } }, 403);
    }

    const { folder_id: folderId } = c.req.valid('json');
    try {
      await deps.sessionStore.setSessionFolder({
        tenant_id: TENANT_ID,
        session_id: sessionId,
        created_by: requestContext.subject.id,
        folder_id: folderId,
      });
    } catch (error) {
      if (error instanceof SessionNotFoundError) {
        return c.json({ error: { message: error.message } }, 404);
      }
      if (error instanceof SessionFolderNotFoundError) {
        return c.json({ error: { message: error.message } }, 404);
      }
      throw error;
    }
    return c.json({}, 200);
  };

  const clearHandler: RouteHandler<typeof clearSessionFolderRoute> = async c => {
    const requestContext = deps.resolveRequestContext(c);
    const { session_id: sessionId } = c.req.valid('param');
    const ownership = await requireOwnedSession(sessionId, requestContext.subject.id);
    if (ownership.error === 'not_found') {
      return c.json({ error: { message: `Session not found: ${sessionId}` } }, 404);
    }
    if (ownership.error === 'forbidden') {
      return c.json({ error: { message: FORBIDDEN_SESSION_ACCESS } }, 403);
    }
    try {
      await deps.sessionStore.setSessionFolder({
        tenant_id: TENANT_ID,
        session_id: sessionId,
        created_by: requestContext.subject.id,
        folder_id: null,
      });
    } catch (error) {
      if (error instanceof SessionNotFoundError) {
        return c.json({ error: { message: error.message } }, 404);
      }
      throw error;
    }
    return c.json({}, 200);
  };

  const router = new OpenAPIHono();
  router.openapi(setSessionFolderRoute, setHandler);
  router.openapi(clearSessionFolderRoute, clearHandler);
  return router;
}

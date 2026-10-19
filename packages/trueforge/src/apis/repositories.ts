import { OpenAPIHono, type RouteHandler } from '@hono/zod-openapi';
import type { ISessionStore, SessionRecord } from '@truefoundry/trueforge-core/agent-session';
import type { ResolveRequestContext } from '../auth/identity';
import {
  RepositoryNameConflictError,
  RepositoryRevisionConflictError,
  RepositoryWorkspaceCwdError,
  VerifyCommandTimeoutError,
  type IRepositoryStore,
  type RepositoryRecord,
  type SessionBindingRecord,
  type VerifyCommandProposalRecord,
  type VerifyCommandRecord,
} from '../db/repositoryStore';
import type { SessionCustom, TurnCustom } from '../db/sessionCustom';
import {
  bindSessionRepositoryRoute,
  confirmVerifyCommandProposalRoute,
  createRepositoryRoute,
  deleteVerifyCommandProposalRoute,
  deleteVerifyCommandRoute,
  getRepositoryRoute,
  getSessionRepositoryRoute,
  listRepositoriesRoute,
  listVerifyCommandProposalsRoute,
  listVerifyCommandsRoute,
  setPackageDownloadsRoute,
  unbindSessionRepositoryRoute,
  upsertVerifyCommandRoute,
} from '../routes/repositoryRoutes';
import { packageMirrorTokens } from '../sandbox/mirrors/packageMirrorTokens';
import type { RepositoryWire, VerifyCommandProposalWire, VerifyCommandWire } from '../schemas/repository';
import { checkSessionAccess, FORBIDDEN_SESSION_ACCESS, TENANT_ID } from './sessions';

function toWireRepository(record: RepositoryRecord): RepositoryWire {
  return {
    id: record.id,
    name: record.name,
    clone_url: record.clone_url,
    default_branch: record.default_branch,
    package_downloads_allowed: record.package_downloads_allowed,
    revision: record.revision,
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
}

function toWireCommand(record: VerifyCommandRecord): VerifyCommandWire {
  return {
    command_id: record.command_id,
    purpose: record.purpose,
    command: record.command,
    timeout_ms: record.timeout_ms,
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
}

function toWireProposal(record: VerifyCommandProposalRecord): VerifyCommandProposalWire {
  return {
    id: record.id,
    purpose: record.purpose,
    command: record.command,
    source_kind: record.source_kind,
    source_path: record.source_path,
    source_fingerprint: record.source_fingerprint,
    created_at: record.created_at,
  };
}

function toWireBinding(record: SessionBindingRecord) {
  return {
    session_id: record.session_id,
    repository_id: record.repository_id,
    workspace_cwd: record.workspace_cwd,
  };
}

function isRepositoryInputError(error: unknown): error is RepositoryWorkspaceCwdError | VerifyCommandTimeoutError {
  return error instanceof RepositoryWorkspaceCwdError || error instanceof VerifyCommandTimeoutError;
}

export interface RepositoriesRouterDeps {
  repositoryStore: IRepositoryStore;
  resolveRequestContext: ResolveRequestContext;
}

/** Repository identity, confirmed commands, and inert command proposals. */
export function createRepositoriesRouter(deps: RepositoriesRouterDeps) {
  const listHandler: RouteHandler<typeof listRepositoriesRoute> = async c => {
    const requestContext = deps.resolveRequestContext(c);
    const records = await deps.repositoryStore.listRepositories({
      tenant_id: TENANT_ID,
      created_by: requestContext.subject.id,
    });
    return c.json({ data: records.map(toWireRepository) }, 200);
  };

  const createHandler: RouteHandler<typeof createRepositoryRoute> = async c => {
    const requestContext = deps.resolveRequestContext(c);
    const body = c.req.valid('json');
    try {
      const record = await deps.repositoryStore.createRepository({
        tenant_id: TENANT_ID,
        created_by: requestContext.subject.id,
        ...body.repository,
      });
      return c.json({ data: toWireRepository(record) }, 201);
    } catch (error) {
      if (error instanceof RepositoryNameConflictError) {
        return c.json({ error: { message: error.message } }, 409);
      }
      throw error;
    }
  };

  const getHandler: RouteHandler<typeof getRepositoryRoute> = async c => {
    const requestContext = deps.resolveRequestContext(c);
    const { repository_id: repositoryId } = c.req.valid('param');
    const record = await deps.repositoryStore.getRepository({
      tenant_id: TENANT_ID,
      created_by: requestContext.subject.id,
      repository_id: repositoryId,
    });
    return record === undefined
      ? c.json({ error: { message: `Repository not found: ${repositoryId}` } }, 404)
      : c.json({ data: toWireRepository(record) }, 200);
  };

  const setPackageDownloadsHandler: RouteHandler<typeof setPackageDownloadsRoute> = async c => {
    const requestContext = deps.resolveRequestContext(c);
    const { repository_id: repositoryId } = c.req.valid('param');
    const body = c.req.valid('json');
    const owner = { tenant_id: TENANT_ID, created_by: requestContext.subject.id, repository_id: repositoryId };
    try {
      const record = await deps.repositoryStore.setPackageDownloadsAllowed({
        ...owner,
        allowed: body.allowed,
        expected_revision: body.expected_revision,
      });
      if (record === undefined) {
        return c.json({ error: { message: `Repository not found: ${repositoryId}` } }, 404);
      }
      if (!body.allowed) {
        // Taking the allowance back ends every live mirror grant for this repo at once.
        packageMirrorTokens.revokeRepository(owner);
      }
      return c.json({ data: toWireRepository(record) }, 200);
    } catch (error) {
      if (error instanceof RepositoryRevisionConflictError) {
        return c.json({ error: { message: error.message } }, 409);
      }
      throw error;
    }
  };

  const listCommandsHandler: RouteHandler<typeof listVerifyCommandsRoute> = async c => {
    const requestContext = deps.resolveRequestContext(c);
    const { repository_id: repositoryId } = c.req.valid('param');
    const owner = { tenant_id: TENANT_ID, created_by: requestContext.subject.id, repository_id: repositoryId };
    const repository = await deps.repositoryStore.getRepository(owner);
    if (repository === undefined) {
      return c.json({ error: { message: `Repository not found: ${repositoryId}` } }, 404);
    }
    const commands = await deps.repositoryStore.listVerifyCommands(owner);
    return c.json({ data: { commands: commands.map(toWireCommand), repository_revision: repository.revision } }, 200);
  };

  const upsertCommandHandler: RouteHandler<typeof upsertVerifyCommandRoute> = async c => {
    const requestContext = deps.resolveRequestContext(c);
    const { repository_id: repositoryId, command_id: commandId } = c.req.valid('param');
    const body = c.req.valid('json');
    const owner = { tenant_id: TENANT_ID, created_by: requestContext.subject.id, repository_id: repositoryId };
    try {
      const mutation = await deps.repositoryStore.upsertVerifyCommand({
        ...owner,
        command_id: commandId,
        purpose: body.purpose,
        command: body.command,
        timeout_ms: body.timeout_ms,
        expected_revision: body.expected_revision,
      });
      if (mutation === undefined) {
        return c.json({ error: { message: `Repository not found: ${repositoryId}` } }, 404);
      }
      return c.json(
        { data: { ...toWireCommand(mutation.command), repository_revision: mutation.repository_revision } },
        200,
      );
    } catch (error) {
      if (isRepositoryInputError(error)) {
        return c.json({ error: { message: error.message } }, 400);
      }
      if (error instanceof RepositoryRevisionConflictError) {
        return c.json({ error: { message: error.message } }, 409);
      }
      throw error;
    }
  };

  const deleteCommandHandler: RouteHandler<typeof deleteVerifyCommandRoute> = async c => {
    const requestContext = deps.resolveRequestContext(c);
    const { repository_id: repositoryId, command_id: commandId } = c.req.valid('param');
    const query = c.req.valid('query');
    const owner = { tenant_id: TENANT_ID, created_by: requestContext.subject.id, repository_id: repositoryId };
    if ((await deps.repositoryStore.getRepository(owner)) === undefined) {
      return c.json({ error: { message: `Repository not found: ${repositoryId}` } }, 404);
    }
    try {
      await deps.repositoryStore.deleteVerifyCommand({
        ...owner,
        command_id: commandId,
        expected_revision: query.expected_revision,
      });
      return c.json({}, 200);
    } catch (error) {
      if (error instanceof RepositoryRevisionConflictError) {
        return c.json({ error: { message: error.message } }, 409);
      }
      throw error;
    }
  };

  const listProposalsHandler: RouteHandler<typeof listVerifyCommandProposalsRoute> = async c => {
    const requestContext = deps.resolveRequestContext(c);
    const { repository_id: repositoryId } = c.req.valid('param');
    const owner = { tenant_id: TENANT_ID, created_by: requestContext.subject.id, repository_id: repositoryId };
    const repository = await deps.repositoryStore.getRepository(owner);
    if (repository === undefined) {
      return c.json({ error: { message: `Repository not found: ${repositoryId}` } }, 404);
    }
    const proposals = await deps.repositoryStore.listVerifyCommandProposals(owner);
    return c.json(
      { data: { proposals: proposals.map(toWireProposal), repository_revision: repository.revision } },
      200,
    );
  };

  const confirmProposalHandler: RouteHandler<typeof confirmVerifyCommandProposalRoute> = async c => {
    const requestContext = deps.resolveRequestContext(c);
    const { repository_id: repositoryId, proposal_id: proposalId } = c.req.valid('param');
    const body = c.req.valid('json');
    const owner = { tenant_id: TENANT_ID, created_by: requestContext.subject.id, repository_id: repositoryId };
    try {
      const mutation = await deps.repositoryStore.confirmVerifyCommandProposal({
        ...owner,
        proposal_id: proposalId,
        command_id: body.command_id,
        timeout_ms: body.timeout_ms,
        expected_revision: body.expected_revision,
      });
      if (mutation === undefined) {
        return c.json({ error: { message: `Repository or proposal not found: ${proposalId}` } }, 404);
      }
      return c.json(
        { data: { ...toWireCommand(mutation.command), repository_revision: mutation.repository_revision } },
        200,
      );
    } catch (error) {
      if (isRepositoryInputError(error)) {
        return c.json({ error: { message: error.message } }, 400);
      }
      if (error instanceof RepositoryRevisionConflictError) {
        return c.json({ error: { message: error.message } }, 409);
      }
      throw error;
    }
  };

  const deleteProposalHandler: RouteHandler<typeof deleteVerifyCommandProposalRoute> = async c => {
    const requestContext = deps.resolveRequestContext(c);
    const { repository_id: repositoryId, proposal_id: proposalId } = c.req.valid('param');
    const owner = { tenant_id: TENANT_ID, created_by: requestContext.subject.id, repository_id: repositoryId };
    if ((await deps.repositoryStore.getRepository(owner)) === undefined) {
      return c.json({ error: { message: `Repository not found: ${repositoryId}` } }, 404);
    }
    await deps.repositoryStore.deleteVerifyCommandProposal({ ...owner, proposal_id: proposalId });
    return c.json({}, 200);
  };

  const router = new OpenAPIHono();
  router.openapi(listRepositoriesRoute, listHandler);
  router.openapi(createRepositoryRoute, createHandler);
  router.openapi(getRepositoryRoute, getHandler);
  router.openapi(setPackageDownloadsRoute, setPackageDownloadsHandler);
  router.openapi(listVerifyCommandsRoute, listCommandsHandler);
  router.openapi(upsertVerifyCommandRoute, upsertCommandHandler);
  router.openapi(deleteVerifyCommandRoute, deleteCommandHandler);
  router.openapi(listVerifyCommandProposalsRoute, listProposalsHandler);
  router.openapi(confirmVerifyCommandProposalRoute, confirmProposalHandler);
  router.openapi(deleteVerifyCommandProposalRoute, deleteProposalHandler);
  return router;
}

export interface SessionRepositoryRouterDeps {
  repositoryStore: IRepositoryStore;
  sessionStore: ISessionStore<SessionCustom, TurnCustom>;
  resolveRequestContext: ResolveRequestContext;
}

/** Session binding surface (mounted at /api/v1/sessions). */
export function createSessionRepositoryRouter(deps: SessionRepositoryRouterDeps) {
  type OwnedSessionResult =
    { status: 'not_found' } | { status: 'forbidden' } | { status: 'ok'; session: SessionRecord<SessionCustom> };
  const getOwnedSession = async (sessionId: string, userRef: string): Promise<OwnedSessionResult> => {
    const session = await deps.sessionStore.getSession({ tenant_id: TENANT_ID, session_id: sessionId });
    if (session === undefined) {
      return { status: 'not_found' };
    }
    if (!checkSessionAccess({ userRef, createdBy: session.created_by_subject.subject_id })) {
      return { status: 'forbidden' };
    }
    return { status: 'ok', session };
  };

  const getHandler: RouteHandler<typeof getSessionRepositoryRoute> = async c => {
    const { session_id: sessionId } = c.req.valid('param');
    const requestContext = deps.resolveRequestContext(c);
    const owned = await getOwnedSession(sessionId, requestContext.subject.id);
    if (owned.status === 'not_found') {
      return c.json({ error: { message: `Session not found: ${sessionId}` } }, 404);
    }
    if (owned.status === 'forbidden') {
      return c.json({ error: { message: FORBIDDEN_SESSION_ACCESS } }, 403);
    }
    return c.json(
      {
        data: {
          session_id: sessionId,
          repository_id: owned.session.repository_id,
          workspace_cwd: owned.session.workspace_cwd,
        },
      },
      200,
    );
  };

  const bindHandler: RouteHandler<typeof bindSessionRepositoryRoute> = async c => {
    const { session_id: sessionId } = c.req.valid('param');
    const requestContext = deps.resolveRequestContext(c);
    const body = c.req.valid('json');
    const owned = await getOwnedSession(sessionId, requestContext.subject.id);
    if (owned.status === 'not_found') {
      return c.json({ error: { message: `Session not found: ${sessionId}` } }, 404);
    }
    if (owned.status === 'forbidden') {
      return c.json({ error: { message: FORBIDDEN_SESSION_ACCESS } }, 403);
    }
    try {
      const binding = await deps.repositoryStore.bindSession({
        tenant_id: TENANT_ID,
        created_by: requestContext.subject.id,
        session_id: sessionId,
        repository_id: body.repository_id,
        workspace_cwd: body.workspace_cwd,
        expected_revision: body.expected_revision,
      });
      return binding === undefined
        ? c.json({ error: { message: `Repository not found: ${body.repository_id}` } }, 404)
        : c.json({ data: toWireBinding(binding) }, 200);
    } catch (error) {
      if (isRepositoryInputError(error)) {
        return c.json({ error: { message: error.message } }, 400);
      }
      if (error instanceof RepositoryRevisionConflictError) {
        return c.json({ error: { message: error.message } }, 409);
      }
      throw error;
    }
  };

  const unbindHandler: RouteHandler<typeof unbindSessionRepositoryRoute> = async c => {
    const { session_id: sessionId } = c.req.valid('param');
    const query = c.req.valid('query');
    const requestContext = deps.resolveRequestContext(c);
    const owned = await getOwnedSession(sessionId, requestContext.subject.id);
    if (owned.status === 'not_found') {
      return c.json({ error: { message: `Session not found: ${sessionId}` } }, 404);
    }
    if (owned.status === 'forbidden') {
      return c.json({ error: { message: FORBIDDEN_SESSION_ACCESS } }, 403);
    }
    try {
      const binding = await deps.repositoryStore.unbindSession({
        tenant_id: TENANT_ID,
        created_by: requestContext.subject.id,
        session_id: sessionId,
        expected_revision: query.expected_revision,
      });
      return binding === undefined
        ? c.json({ error: { message: `Session not found: ${sessionId}` } }, 404)
        : c.json({}, 200);
    } catch (error) {
      if (error instanceof RepositoryRevisionConflictError) {
        return c.json({ error: { message: error.message } }, 409);
      }
      throw error;
    }
  };

  const router = new OpenAPIHono();
  router.openapi(getSessionRepositoryRoute, getHandler);
  router.openapi(bindSessionRepositoryRoute, bindHandler);
  router.openapi(unbindSessionRepositoryRoute, unbindHandler);
  return router;
}

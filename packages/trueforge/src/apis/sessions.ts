/**
 * DB-backed sessions APIs (mounted at /api/v1/sessions and /api/internal/sessions).
 */
import { join } from 'node:path';

import { OpenAPIHono, type RouteHandler } from '@hono/zod-openapi';
import {
  abnormalHandoffCauseForCancellation,
  CancellationReason,
  SessionStoreConflictError,
  SessionStoreInvariantError,
  SessionStoreNotFoundError,
  TurnNotFoundError,
  withoutClearedApprovalEvent,
  type ISessionStore,
  type SessionHandle,
  type SessionRecord,
  type Sessions,
} from '@truefoundry/trueforge-core/agent-session';
import { extractErrorLogFields, mechanicalAbnormalHandoff } from '@truefoundry/trueforge-core/core';
import { upgradeStoredSessionEventItem } from '@truefoundry/trueforge-core/core/permissions/storedCards';
import {
  redisRequest,
  RequestTimeoutError,
  type RouteHandler as RequestReplyRouteHandler,
  type RequestReplyRouter,
} from '@truefoundry/trueforge-core/request-reply';
import type { Context } from 'hono';
import type { RedisClientType } from 'redis';
import type { Logger } from 'winston';
import { z } from 'zod';
import type { Authorizer } from '../auth/authorizer';
import { createdBySubjectFromRequestContext, type ResolveRequestContext } from '../auth/identity';
import type { McpCatalog } from '../catalog/McpCatalog';
import configuration from '../config';
import type { IAgentStore } from '../db/agentStore';
import type { DeleteChatInput, IChatDeletionStore } from '../db/chatDeletionStore';
import type { IMcpServerStore } from '../db/mcpServerStore';
import type { IModelProviderStore } from '../db/modelProviderStore';
import type { ISandboxProviderStore } from '../db/sandboxProviderStore';
import type { ISentinelAuditStore } from '../db/sentinelAuditStore';
import type { SessionCustom, TurnCustom } from '../db/sessionCustom';
import {
  cancelSessionRoute,
  createSessionRoute,
  deleteSessionRoute,
  getOrCreateSessionByExternalIdRoute,
  getSessionAuditLogRoute,
  getSessionRoute,
  listImplementationPlanGrantsRoute,
  listSessionEventsRoute,
  listSessionsRoute,
  revokeImplementationPlanGrantRoute,
  updateSessionRoute,
} from '../routes/sessionRoutes';
import type { ActiveTurnRegistry } from '../runtime/activeTurns';
import { executorFromTurnId } from '../runtime/peeringIds';
import { PRIVATE_CHAT_FLAG_CHANGE_MESSAGE, privateChatExpiry, sessionKeepsNothing } from '../runtime/privateChat';
import { localSandboxSessionSegment, validateAgentSpec } from '../runtime/sessionResources';
import type { TurnDrainRegistry } from '../runtime/turnDrains';
import { removeLocalChatSandboxes } from '../sandbox/localLifecycle';
import { packageMirrorTokens } from '../sandbox/mirrors/packageMirrorTokens';
import { removeSlotWorkspace, slotsBackendEnabled } from '../sandbox/slotBackend';
import { honoQueriesToRecord } from '../schemas/deepObjectQuery';
import { isSessionAgentNameRef, parseListSessionsQuery, type Session } from '../schemas/session';
import { newId } from '../utils/id';
import { agentIfAccessible, canReadSession, resolveManagedAgentIds } from './agentAccess';
import type { ResolveSkillStore } from './skills';

/** Request-reply path a replica serves to cancel a turn it owns. */
export const SESSIONS_CANCEL_PATH = 'sessions/cancel';

/** Wire body of a peer cancel; validated on receipt (it crosses processes via Redis). */
const CancelPeerBodySchema = z.object({
  session_id: z.string(),
  turn_id: z.string(),
  reason: z.enum(CancellationReason),
});
type CancelPeerBody = z.infer<typeof CancelPeerBodySchema>;

export function toWireSession(record: SessionRecord): Session {
  return {
    id: record.session_id,
    agent: record.agent,
    title: record.title,
    folder_id: record.folder_id,
    created_by_subject: record.created_by_subject,
    created_at: record.created_at.toISOString(),
    updated_at: record.updated_at.toISOString(),
    approval_grants: record.approval_grants,
    metrics: record.metrics,
    metadata: record.metadata,
    source: record.source,
    is_incognito: record.is_incognito,
    private_expires_at: record.private_expires_at === null ? null : record.private_expires_at.toISOString(),
  };
}

/** The sandbox a chat last used, so its stored workspace can be removed with the chat. */
export async function sandboxIdOfLastTurn(input: {
  deps: { sessionStore: Pick<ISessionStore<SessionCustom, TurnCustom>, 'getTurn'>; logger: Pick<Logger, 'warn'> };
  record: Pick<SessionRecord, 'session_id' | 'last_turn_id'>;
}): Promise<string | undefined> {
  if (input.record.last_turn_id === null) {
    return undefined;
  }
  try {
    const turn = await input.deps.sessionStore.getTurn({
      session_id: input.record.session_id,
      turn_id: input.record.last_turn_id,
    });
    return turn?.snapshot.sandbox_info?.sandbox_id;
  } catch (error) {
    input.deps.logger.warn('Could not look up the sandbox of a chat being deleted', extractErrorLogFields(error));
    return undefined;
  }
}

export interface SessionsRouterDeps {
  sessions: Sessions<SessionCustom, TurnCustom>;
  sessionStore: ISessionStore<SessionCustom, TurnCustom>;
  chatDeletionStore: IChatDeletionStore;
  sentinelAuditStore: ISentinelAuditStore;
  activeTurns: ActiveTurnRegistry;
  turnDrains: TurnDrainRegistry;
  resolveModelProviderStore: (c: Context) => IModelProviderStore;
  resolveMcpServerStore: (c: Context) => IMcpServerStore;
  resolveSkillStore: ResolveSkillStore;
  resolveAgentStore: (c: Context) => IAgentStore;
  resolveSandboxProviderStore: (c: Context) => ISandboxProviderStore;
  redis?: RedisClientType | undefined;
  /** When present, remembered mounts of a deleted search provider do not fail validation. */
  mcpCatalog?: McpCatalog | undefined;
  requestReplyRouter: RequestReplyRouter;
  resolveRequestContext: ResolveRequestContext;
  logger: Logger;
  authorizer: Authorizer;
}

function cancelTurnOnThisExecutor(
  activeTurns: ActiveTurnRegistry,
  input: { sessionId: string; turnId: string; reason: CancellationReason },
): boolean {
  return activeTurns.cancelIfRunning({
    sessionId: input.sessionId,
    turnId: input.turnId,
    abortReason: input.reason,
  });
}

/**
 * Peer-facing cancel handler: aborts the turn if it runs in this process.
 * 200 = abort fired, 412 = not running here (treated by callers as a no-op).
 */
export function cancelSessionTurnPeerHandler(activeTurns: ActiveTurnRegistry): RequestReplyRouteHandler {
  // Synchronous by nature; the transport expects a Promise and require-await
  // forbids an async fn without awaits.
  return request => {
    const parsed = CancelPeerBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return Promise.resolve({ status: 400, body: { message: 'Invalid sessions/cancel payload' } });
    }
    const found = cancelTurnOnThisExecutor(activeTurns, {
      sessionId: parsed.data.session_id,
      turnId: parsed.data.turn_id,
      reason: parsed.data.reason,
    });
    return Promise.resolve(
      found ? { status: 200, body: {} } : { status: 412, body: { message: 'Turn is not running on this executor' } },
    );
  };
}

/** A registry to abort in, a session to freeze, durable state to read, and a way to reach peers. */
export interface CancelTurnDeps {
  activeTurns: ActiveTurnRegistry;
  session: Pick<SessionHandle<SessionCustom, TurnCustom>, 'session_id' | 'record' | 'freezeTurn'>;
  sessionStore: Pick<ISessionStore<SessionCustom, TurnCustom>, 'getTurn'>;
  redis?: RedisClientType | undefined;
  logger: Pick<Logger, 'warn'>;
}

/**
 * Cancels the turn wherever it runs: locally or on the owning peer over Redis
 * request-reply. Callers state the motive; default is a plain client cancel.
 *
 * On this process the run is aborted and the turn is then frozen, so a step
 * that ignores the abort cannot keep it `running`. A peer's confirmed abort
 * (HTTP 200) lets that peer's TurnHandle persist the terminal state. If the
 * abort cannot be confirmed, this replica freezes the turn in the store.
 *
 * Redis timeout and Redis/transport failures are not a clean cancellation —
 * the owning replica may still be executing — but the turn is still frozen.
 * Later writes from that replica lose to first-terminal-write-wins.
 */
export async function cancelSessionTurn(
  deps: CancelTurnDeps,
  input: { turnId: string; reason?: CancellationReason },
): Promise<void> {
  const { turnId, reason = CancellationReason.ClientCancelled } = input;
  const sessionId = deps.session.session_id;

  const turn = await deps.sessionStore.getTurn({
    session_id: sessionId,
    turn_id: turnId,
  });
  if (turn?.state.status !== 'running') {
    // Missing or already terminal — nothing to cancel.
    return;
  }

  const owner = executorFromTurnId(turnId);
  // Without a Redis client there is no peer to ask, so an id naming another
  // replica falls through to the local lookup and freezes if the run is gone.
  if (owner !== configuration.EXECUTOR_ID && deps.redis) {
    try {
      const reply = await redisRequest<CancelPeerBody>({
        redis: deps.redis,
        executorId: owner,
        path: SESSIONS_CANCEL_PATH,
        request: {
          body: { session_id: sessionId, turn_id: turnId, reason },
        },
        options: {
          replyTimeoutMs: configuration.REDIS_REQUEST_REPLY_TIMEOUT_MS,
          pollIntervalMs: configuration.REDIS_REQUEST_REPLY_POLL_INTERVAL_MS,
        },
      });
      if (reply.status === 200) {
        return;
      }
    } catch (error) {
      const fields = {
        sessionId,
        turnId,
        owner,
        ...extractErrorLogFields(error),
      };
      if (error instanceof RequestTimeoutError) {
        deps.logger.warn('Timed out waiting for owning executor to cancel; freezing the running turn', fields);
      } else {
        deps.logger.warn('Failed to reach owning executor over Redis; freezing the running turn', fields);
      }
    }
    await freezeTurnIgnoringMissing(deps.session, { turnId, reason });
    return;
  }

  const found = cancelTurnOnThisExecutor(deps.activeTurns, { sessionId, turnId, reason });
  // A turn still marked running from before this process started lost its run to a restart.
  // It is recorded as such, so the chat can say why the reply stopped when it is opened again.
  const endReason = !found && deps.activeTurns.predates(turn.created_at) ? CancellationReason.Abandoned : reason;
  // Also when the run was found: a step that ignores the abort must not keep the turn running.
  // The freeze waits briefly for the run to settle and is a no-op once it has ended itself.
  await freezeTurnIgnoringMissing(deps.session, { turnId, reason: endReason });
}

/** What deleting a chat needs: its running turn stopped, its rows removed, its workspace freed. */
export type DeleteChatDeps = Pick<
  SessionsRouterDeps,
  'sessions' | 'sessionStore' | 'chatDeletionStore' | 'activeTurns' | 'turnDrains' | 'redis' | 'logger'
>;

/** A sweep deletes only a private chat past its expiry; a chat a turn just renewed is left alone. */
function isDueForDeletion({
  record,
  expiredBy,
}: {
  record: Pick<SessionRecord, 'is_incognito' | 'private_expires_at'>;
  expiredBy: Date | undefined;
}): boolean {
  if (expiredBy === undefined) {
    return true;
  }
  return record.is_incognito && record.private_expires_at !== null && record.private_expires_at <= expiredBy;
}

/** How long a delete waits for the stopped turn to finish saving its files. */
const DELETE_CHAT_CAPTURE_WAIT_MS = 10_000;

/**
 * Deletes a chat for real: stops a turn still running in it, waits for that turn's file saving,
 * then removes every row and blob the chat owns in one transaction. Approvals, held actions and
 * the action audit are not the chat's and stay. Returns false when the chat was already gone.
 */
export async function deleteChat(deps: DeleteChatDeps, input: DeleteChatInput): Promise<boolean> {
  const session = await deps.sessions.get({ tenant_id: input.tenant_id, session_id: input.session_id });
  if (session === undefined || !isDueForDeletion({ record: session.record, expiredBy: input.expired_by })) {
    return false;
  }
  deps.activeTurns.cancelAdmissions({ sessionId: input.session_id, abortReason: CancellationReason.ClientCancelled });
  if (session.record.last_turn_id !== null) {
    await cancelSessionTurn(
      {
        activeTurns: deps.activeTurns,
        session,
        sessionStore: deps.sessionStore,
        redis: deps.redis,
        logger: deps.logger,
      },
      { turnId: session.record.last_turn_id },
    );
  }
  const stillSaving = await deps.turnDrains.waitForArtifactCapture({
    sessionId: input.session_id,
    timeoutMs: DELETE_CHAT_CAPTURE_WAIT_MS,
  });
  if (stillSaving !== undefined) {
    // Files that land after the delete belong to no chat; the expiry sweep removes them.
    deps.logger.warn('A deleted chat was still saving files', { session_id: input.session_id });
  }
  const sandboxId = slotsBackendEnabled() ? await sandboxIdOfLastTurn({ deps, record: session.record }) : undefined;
  const deleted = await deps.chatDeletionStore.deleteChat(input);
  // A deleted chat keeps no package download grant.
  packageMirrorTokens.revokeSession(input.session_id);
  if (sandboxId !== undefined) {
    void removeSlotWorkspace({ sandboxId, logger: deps.logger });
  }
  const localSegment = localSandboxSessionSegment(input.session_id);
  // Local sandboxes exist only in standalone mode, each chat's in its own folder; their files go with the chat.
  if (
    deleted &&
    configuration.STANDALONE &&
    !slotsBackendEnabled() &&
    localSegment !== localSandboxSessionSegment(undefined)
  ) {
    const chatFolder = join(configuration.LOCAL_SANDBOX_ROOT_PARENT, localSegment);
    await removeLocalChatSandboxes({ chatFolder }).catch((error: unknown) => {
      deps.logger.warn('Could not remove the sandbox files of a deleted chat', {
        session_id: input.session_id,
        ...extractErrorLogFields(error),
      });
    });
  }
  return deleted;
}

/** Freeze a running turn; missing turns are a no-op (already gone). */
async function freezeTurnIgnoringMissing(
  session: Pick<SessionHandle<SessionCustom, TurnCustom>, 'record' | 'freezeTurn'>,
  input: { turnId: string; reason: CancellationReason },
): Promise<void> {
  const repository =
    session.record.repository_id === null || session.record.workspace_cwd === null
      ? undefined
      : {
          repository_id: session.record.repository_id,
          revision: null,
          workspace_cwd: session.record.workspace_cwd,
        };
  try {
    await session.freezeTurn({
      turn_id: input.turnId,
      reason: input.reason,
      handoff: mechanicalAbnormalHandoff({
        cause: abnormalHandoffCauseForCancellation(input.reason),
        repository,
      }),
    });
  } catch (error) {
    if (error instanceof TurnNotFoundError) {
      return;
    }
    throw error;
  }
}

export const FORBIDDEN_SESSION_ACCESS = 'Only the session creator can access this session';

/**
 * Default single-tenant id. Canonical definition lives in `../tenancy`;
 * re-exported here so existing importers keep working. New code outside the
 * API layer should import it from `../tenancy` directly.
 */
export { TENANT_ID } from '../tenancy';

/**
 * Kept for API modules that still compare against a bare `created_by` string
 * (personas, repositories, sessionFolders, bugReport). New code should use
 * `isSessionOwner`, which compares against `created_by_subject.subject_id`.
 */
export function checkSessionAccess({ userRef, createdBy }: { userRef: string; createdBy: string }): boolean {
  return userRef === createdBy;
}

function isSessionOwner({
  subject_id,
  created_by_subject,
}: {
  subject_id: string;
  created_by_subject: { subject_id: string };
}): boolean {
  return subject_id === created_by_subject.subject_id;
}

type InternalSessionsRouterDeps = Pick<
  SessionsRouterDeps,
  | 'sessions'
  | 'mcpCatalog'
  | 'resolveModelProviderStore'
  | 'resolveMcpServerStore'
  | 'resolveSkillStore'
  | 'resolveAgentStore'
  | 'resolveSandboxProviderStore'
  | 'resolveRequestContext'
  | 'authorizer'
>;

function createGetOrCreateSessionByExternalIdHandler(
  deps: InternalSessionsRouterDeps,
): RouteHandler<typeof getOrCreateSessionByExternalIdRoute> {
  return async c => {
    const body = c.req.valid('json');
    const requestContext = deps.resolveRequestContext(c);

    const existing = await deps.sessions.getByExternalId({
      tenant_id: requestContext.tenant_id,
      external_id: body.external_id,
    });
    if (existing !== undefined) {
      if (
        !(await canReadSession({
          store: deps.resolveAgentStore(c),
          context: requestContext,
          authorizer: deps.authorizer,
          record: existing.record,
        }))
      ) {
        return c.json({ error: { message: FORBIDDEN_SESSION_ACCESS } }, 403);
      }
      return c.json({ data: toWireSession(existing.record) }, 200);
    }

    let agent: SessionRecord['agent'];
    if (isSessionAgentNameRef(body.agent)) {
      const named = await agentIfAccessible({
        authorizer: deps.authorizer,
        context: requestContext,
        action: 'use',
        agent: await deps.resolveAgentStore(c).getAgent({
          tenant_id: requestContext.tenant_id,
          name: body.agent.name,
        }),
      });
      if (named === undefined) {
        return c.json({ error: { message: `Agent not found: ${body.agent.name}` } }, 404);
      }
      agent = { type: 'reference', id: named.id, name: named.name };
    } else {
      await validateAgentSpec({
        spec: body.agent.spec,
        tenant_id: requestContext.tenant_id,
        modelProviderStore: deps.resolveModelProviderStore(c),
        mcpServerStore: deps.resolveMcpServerStore(c),
        skillStore: deps.resolveSkillStore(c),
        sandboxProviderStore: deps.resolveSandboxProviderStore(c),
        searchProviderPresetNames: deps.mcpCatalog?.searchProviderPresetNames(),
      });
      agent = { type: 'inline', spec: body.agent.spec };
    }

    const { session, created } = await deps.sessions.getOrCreateByExternalId({
      tenant_id: requestContext.tenant_id,
      external_id: body.external_id,
      created_by_subject: createdBySubjectFromRequestContext(requestContext),
      agent,
      source: body.source ?? null,
    });
    if (
      !created &&
      !(await canReadSession({
        store: deps.resolveAgentStore(c),
        context: requestContext,
        authorizer: deps.authorizer,
        record: session.record,
      }))
    ) {
      return c.json({ error: { message: FORBIDDEN_SESSION_ACCESS } }, 403);
    }
    return c.json({ data: toWireSession(session.record) }, created ? 201 : 200);
  };
}

/** Internal session operations (mounted at /api/internal/sessions). */
export function createInternalSessionsRouter(deps: InternalSessionsRouterDeps) {
  const router = new OpenAPIHono();
  router.openapi(getOrCreateSessionByExternalIdRoute, createGetOrCreateSessionByExternalIdHandler(deps));
  return router;
}

/** DB-backed sessions (mounted at /api/v1/sessions). */
export function createSessionsRouter(deps: SessionsRouterDeps) {
  const createSessionHandler: RouteHandler<typeof createSessionRoute> = async c => {
    const body = c.req.valid('json');
    const sessionId = newId();
    const requestContext = deps.resolveRequestContext(c);
    const privacy =
      body.is_incognito === true
        ? { is_incognito: true, private_expires_at: privateChatExpiry({ from: new Date() }) }
        : { is_incognito: false, private_expires_at: null };

    if (isSessionAgentNameRef(body.agent)) {
      const agent = await agentIfAccessible({
        authorizer: deps.authorizer,
        context: requestContext,
        action: 'use',
        agent: await deps.resolveAgentStore(c).getAgent({
          tenant_id: requestContext.tenant_id,
          name: body.agent.name,
        }),
      });
      if (agent === undefined) {
        return c.json({ error: { message: `Agent not found: ${body.agent.name}` } }, 404);
      }
      const session = await deps.sessions.create({
        tenant_id: requestContext.tenant_id,
        session_id: sessionId,
        created_by_subject: createdBySubjectFromRequestContext(requestContext),
        agent: { type: 'reference', id: agent.id, name: agent.name },
        metadata: body.metadata,
        external_id: null,
        ...privacy,
      });
      return c.json({ data: toWireSession(session.record) }, 201);
    }

    await validateAgentSpec({
      spec: body.agent.spec,
      tenant_id: requestContext.tenant_id,
      modelProviderStore: deps.resolveModelProviderStore(c),
      mcpServerStore: deps.resolveMcpServerStore(c),
      skillStore: deps.resolveSkillStore(c),
      sandboxProviderStore: deps.resolveSandboxProviderStore(c),
      searchProviderPresetNames: deps.mcpCatalog?.searchProviderPresetNames(),
    });
    const session = await deps.sessions.create({
      tenant_id: requestContext.tenant_id,
      session_id: sessionId,
      created_by_subject: createdBySubjectFromRequestContext(requestContext),
      agent: { type: 'inline', spec: body.agent.spec },
      metadata: body.metadata,
      external_id: null,
      ...privacy,
    });
    return c.json({ data: toWireSession(session.record) }, 201);
  };

  const getSessionHandler: RouteHandler<typeof getSessionRoute> = async c => {
    const { session_id: sessionId } = c.req.valid('param');
    const requestContext = deps.resolveRequestContext(c);
    const record = await deps.sessionStore.getSession({
      tenant_id: requestContext.tenant_id,
      session_id: sessionId,
    });
    if (!record) {
      return c.json({ error: { message: `Session not found: ${sessionId}` } }, 404);
    }
    if (
      !(await canReadSession({
        store: deps.resolveAgentStore(c),
        context: requestContext,
        authorizer: deps.authorizer,
        record,
      }))
    ) {
      return c.json({ error: { message: FORBIDDEN_SESSION_ACCESS } }, 403);
    }
    return c.json({ data: toWireSession(record) }, 200);
  };

  const deleteSessionHandler: RouteHandler<typeof deleteSessionRoute> = async c => {
    const { session_id: sessionId } = c.req.valid('param');
    const requestContext = deps.resolveRequestContext(c);
    const record = await deps.sessionStore.getSession({
      tenant_id: requestContext.tenant_id,
      session_id: sessionId,
    });
    if (!record) {
      // Idempotent delete when already gone.
      return c.body(null, 204);
    }
    if (
      !isSessionOwner({
        subject_id: requestContext.subject.id,
        created_by_subject: record.created_by_subject,
      })
    ) {
      return c.json({ error: { message: FORBIDDEN_SESSION_ACCESS } }, 403);
    }
    await deleteChat(deps, { tenant_id: requestContext.tenant_id, session_id: sessionId, expired_by: undefined });
    return c.body(null, 204);
  };

  const updateSessionHandler: RouteHandler<typeof updateSessionRoute> = async c => {
    const { session_id: sessionId } = c.req.valid('param');
    const body = c.req.valid('json');
    const requestContext = deps.resolveRequestContext(c);
    const existing = await deps.sessionStore.getSession({
      tenant_id: requestContext.tenant_id,
      session_id: sessionId,
    });
    if (!existing) {
      return c.json({ error: { message: `Session not found: ${sessionId}` } }, 404);
    }
    if (
      !isSessionOwner({
        subject_id: requestContext.subject.id,
        created_by_subject: existing.created_by_subject,
      })
    ) {
      return c.json({ error: { message: FORBIDDEN_SESSION_ACCESS } }, 403);
    }
    if (body.is_incognito !== undefined && body.is_incognito !== existing.is_incognito) {
      return c.json({ error: { message: PRIVATE_CHAT_FLAG_CHANGE_MESSAGE } }, 422);
    }
    // Inline sessions may replace their agent; named (reference) sessions
    // cannot — the store rejects that with SessionStoreInvariantError → 422 below.
    if (body.agent !== undefined) {
      await validateAgentSpec({
        spec: body.agent.spec,
        tenant_id: requestContext.tenant_id,
        modelProviderStore: deps.resolveModelProviderStore(c),
        mcpServerStore: deps.resolveMcpServerStore(c),
        skillStore: deps.resolveSkillStore(c),
        sandboxProviderStore: deps.resolveSandboxProviderStore(c),
        searchProviderPresetNames: deps.mcpCatalog?.searchProviderPresetNames(),
      });
    }
    try {
      await deps.sessionStore.updateSession({
        tenant_id: requestContext.tenant_id,
        session_id: sessionId,
        agent: body.agent === undefined ? undefined : { type: 'inline', spec: body.agent.spec },
        title: body.title,
        metadata: body.metadata,
      });
    } catch (error) {
      if (error instanceof SessionStoreNotFoundError) {
        return c.json({ error: { message: `Session not found: ${sessionId}` } }, 404);
      }
      if (error instanceof SessionStoreInvariantError) {
        return c.json({ error: { message: error.message } }, 422);
      }
      throw error;
    }
    const record = await deps.sessionStore.getSession({
      tenant_id: requestContext.tenant_id,
      session_id: sessionId,
    });
    if (!record) {
      return c.json({ error: { message: `Session not found: ${sessionId}` } }, 404);
    }
    return c.json({ data: toWireSession(record) }, 200);
  };

  const listSessionsHandler: RouteHandler<typeof listSessionsRoute> = async c => {
    const query = parseListSessionsQuery(honoQueriesToRecord(c.req.queries()));
    const requestContext = deps.resolveRequestContext(c);
    try {
      const managedAgentIds = query.created_by_me
        ? []
        : await resolveManagedAgentIds({
            store: deps.resolveAgentStore(c),
            context: requestContext,
            authorizer: deps.authorizer,
          });
      const { data, pagination } = await deps.sessionStore.listSessions({
        agent_id: query.agent_id,
        folder_id: query.folder_id,
        no_folder: query.no_folder ?? false,
        created_by_or_agent_ids: {
          created_by_subject_id: requestContext.subject.id,
          agent_ids: managedAgentIds,
        },
        tenant_id: requestContext.tenant_id,
        metadata: query.metadata,
        limit: query.limit,
        order: query.order,
        page_token: query.page_token,
        start_timestamp: query.start_timestamp,
        end_timestamp: query.end_timestamp,
        source_type: query.source_type,
        source_id: query.source_id,
        include_private: query.include_private ?? false,
      });
      // A private chat is listed only to the person who started it, never to an agent's managers.
      const visible = data.filter(
        record =>
          !sessionKeepsNothing({ session: record }) ||
          isSessionOwner({ subject_id: requestContext.subject.id, created_by_subject: record.created_by_subject }),
      );
      return c.json({ data: visible.map(toWireSession), pagination }, 200);
    } catch (error) {
      if (error instanceof SessionStoreConflictError) {
        return c.json({ error: { message: error.message } }, 400);
      }
      throw error;
    }
  };

  const cancelSessionHandler: RouteHandler<typeof cancelSessionRoute> = async c => {
    const { session_id: sessionId } = c.req.valid('param');
    const requestContext = deps.resolveRequestContext(c);
    const session = await deps.sessions.get({
      tenant_id: requestContext.tenant_id,
      session_id: sessionId,
    });
    if (!session) {
      return c.json({ error: { message: `Session not found: ${sessionId}` } }, 404);
    }
    if (
      !isSessionOwner({
        subject_id: requestContext.subject.id,
        created_by_subject: session.record.created_by_subject,
      })
    ) {
      return c.json({ error: { message: FORBIDDEN_SESSION_ACCESS } }, 403);
    }
    const requested = c.req.valid('json').turn_id;
    if (requested !== undefined) {
      // Only the named turn: a message typed meanwhile in the same chat keeps running.
      await cancelSessionTurn({ ...deps, session }, { turnId: requested });
      return c.json({}, 200);
    }
    // A turn still being set up is not the chat's last turn yet, so it is stopped here too.
    deps.activeTurns.cancelAdmissions({ sessionId, abortReason: CancellationReason.ClientCancelled });
    const turnId = session.record.last_turn_id;
    if (!turnId) {
      return c.json({}, 200);
    }

    await cancelSessionTurn({ ...deps, session }, { turnId });
    return c.json({}, 200);
  };

  const listSessionEventsHandler: RouteHandler<typeof listSessionEventsRoute> = async c => {
    const { session_id: sessionId } = c.req.valid('param');
    const query = c.req.valid('query');
    const requestContext = deps.resolveRequestContext(c);
    const session = await deps.sessions.get({
      tenant_id: requestContext.tenant_id,
      session_id: sessionId,
    });
    if (!session) {
      return c.json({ error: { message: `Session not found: ${sessionId}` } }, 404);
    }
    if (
      !(await canReadSession({
        store: deps.resolveAgentStore(c),
        context: requestContext,
        authorizer: deps.authorizer,
        record: session.record,
      }))
    ) {
      return c.json({ error: { message: FORBIDDEN_SESSION_ACCESS } }, 403);
    }
    try {
      const { data, pagination } = await session.listEvents({
        limit: query.limit,
        page_token: query.page_token,
        last_turn_id: query.last_turn_id,
        types: query.types,
        after_event_id: query.after_event_id,
      });
      // Cards cleared after their request ended stay cleared on reload, so the feed drops them too.
      const cleared = await session.clearedApprovalKeys();
      const visible = data.flatMap(item => {
        const event = withoutClearedApprovalEvent(item.event, cleared);
        return event === undefined ? [] : [{ ...item, event }];
      });
      return c.json(
        {
          data: visible.map(item => upgradeStoredSessionEventItem(item)),
          pagination,
        },
        200,
      );
    } catch (error) {
      if (error instanceof SessionStoreConflictError) {
        return c.json({ error: { message: error.message } }, 400);
      }
      if (error instanceof SessionStoreNotFoundError) {
        return c.json({ error: { message: error.message } }, 404);
      }
      throw error;
    }
  };

  const listImplementationPlanGrantsHandler: RouteHandler<typeof listImplementationPlanGrantsRoute> = async c => {
    const { session_id: sessionId } = c.req.valid('param');
    const requestContext = deps.resolveRequestContext(c);
    const record = await deps.sessionStore.getSession({ tenant_id: requestContext.tenant_id, session_id: sessionId });
    if (record === undefined) {
      return c.json({ error: { message: `Session not found: ${sessionId}` } }, 404);
    }
    if (
      !isSessionOwner({
        subject_id: requestContext.subject.id,
        created_by_subject: record.created_by_subject,
      })
    ) {
      return c.json({ error: { message: FORBIDDEN_SESSION_ACCESS } }, 403);
    }
    const data = await deps.sessionStore.listImplementationPlanGrants({
      tenant_id: requestContext.tenant_id,
      created_by: requestContext.subject.id,
      session_id: sessionId,
    });
    return c.json({ data }, 200);
  };

  const revokeImplementationPlanGrantHandler: RouteHandler<typeof revokeImplementationPlanGrantRoute> = async c => {
    const { session_id: sessionId, grant_id: grantId } = c.req.valid('param');
    const requestContext = deps.resolveRequestContext(c);
    const record = await deps.sessionStore.getSession({ tenant_id: requestContext.tenant_id, session_id: sessionId });
    if (record === undefined) {
      return c.json({ error: { message: `Session not found: ${sessionId}` } }, 404);
    }
    if (
      !isSessionOwner({
        subject_id: requestContext.subject.id,
        created_by_subject: record.created_by_subject,
      })
    ) {
      return c.json({ error: { message: FORBIDDEN_SESSION_ACCESS } }, 403);
    }
    try {
      const result = await deps.sessionStore.revokeImplementationPlanGrant({
        tenant_id: requestContext.tenant_id,
        created_by: requestContext.subject.id,
        session_id: sessionId,
        grant_id: grantId,
      });
      if (result.status === 'pending') {
        return c.json(
          {
            error: {
              message: 'The grant is revoked for future admissions, but an already-admitted dispatch is still pending.',
            },
          },
          409,
        );
      }
      return c.json({}, 200);
    } catch (error) {
      if (error instanceof SessionStoreConflictError) {
        return c.json({ error: { message: error.message } }, 409);
      }
      throw error;
    }
  };

  const getSessionAuditLogHandler: RouteHandler<typeof getSessionAuditLogRoute> = async c => {
    const { session_id: sessionId } = c.req.valid('param');
    const query = c.req.valid('query');
    const requestContext = deps.resolveRequestContext(c);
    const record = await deps.sessionStore.getSession({ tenant_id: requestContext.tenant_id, session_id: sessionId });
    if (record === undefined) {
      return c.json({ error: { message: `Session not found: ${sessionId}` } }, 404);
    }
    if (
      !isSessionOwner({
        subject_id: requestContext.subject.id,
        created_by_subject: record.created_by_subject,
      })
    ) {
      return c.json({ error: { message: FORBIDDEN_SESSION_ACCESS } }, 403);
    }
    const entries = await deps.sentinelAuditStore.list({
      tenant_id: requestContext.tenant_id,
      created_by: requestContext.subject.id,
      conversation_id: sessionId,
      limit: query.limit,
      offset: query.offset,
    });
    return c.json({ entries }, 200);
  };

  const router = new OpenAPIHono();
  router.openapi(createSessionRoute, createSessionHandler);
  router.openapi(getSessionRoute, getSessionHandler);
  router.openapi(deleteSessionRoute, deleteSessionHandler);
  router.openapi(updateSessionRoute, updateSessionHandler);
  router.openapi(listSessionsRoute, listSessionsHandler);
  router.openapi(cancelSessionRoute, cancelSessionHandler);
  router.openapi(listSessionEventsRoute, listSessionEventsHandler);
  router.openapi(listImplementationPlanGrantsRoute, listImplementationPlanGrantsHandler);
  router.openapi(revokeImplementationPlanGrantRoute, revokeImplementationPlanGrantHandler);
  router.openapi(getSessionAuditLogRoute, getSessionAuditLogHandler);
  deps.requestReplyRouter.registerRoute(SESSIONS_CANCEL_PATH, cancelSessionTurnPeerHandler(deps.activeTurns));
  return router;
}

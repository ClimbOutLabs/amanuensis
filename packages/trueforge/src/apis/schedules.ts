/**
 * Schedules API (mounted at /api/v1/schedules).
 */
import { OpenAPIHono, type RouteHandler } from '@hono/zod-openapi';
import {
  InvalidPageTokenError,
  type ISessionStore,
  type Sessions,
  type TurnStreamingEvent,
} from '@truefoundry/trueforge-core/agent-session';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { Logger } from 'winston';
import type { Authorizer } from '../auth/authorizer';
import {
  createdBySubjectFromRequestContext,
  requestContextFromCreatedBySubject,
  type RequestContext,
  type ResolveRequestContext,
} from '../auth/identity';
import type { McpCatalog } from '../catalog/McpCatalog';
import configuration from '../config';
import {
  loadScheduleDispatchItem,
  ScheduleAgentNotFoundError,
  ScheduleNotFoundError,
  SchedulePersonaNotFoundError,
  scheduleRunFailureReason,
  ScheduleRunNotFoundError,
  startScheduleRun,
} from '../controller/scheduleDispatch';
import type { AgentRecord, IAgentStore } from '../db/agentStore';
import type { IBriefItemCompletionStore } from '../db/briefItemCompletionStore';
import type { ICompletedTurnEventStore } from '../db/completedTurnEvents';
import type { IGlobalSettingsStore } from '../db/globalSettingsStore';
import type { IGoogleConnectionStore } from '../db/googleConnectionStore';
import type { IMcpServerWithAuthStore } from '../db/mcpServerStore';
import type { IModelProviderStore } from '../db/modelProviderStore';
import type { IPersonalizationStore } from '../db/personalizationStore';
import type { IPersonaStore } from '../db/personaStore';
import type { IRepositoryStore } from '../db/repositoryStore';
import type { ISandboxProviderStore } from '../db/sandboxProviderStore';
import {
  manualRunName,
  ScheduleNameConflictError,
  ScheduleRunConflictError,
  type IScheduleStore,
  type ScheduleDispatchItem,
  type ScheduleRecord,
  type ScheduleRunRecord,
} from '../db/scheduleStore';
import type { SessionCustom, TurnCustom } from '../db/sessionCustom';
import type { ISkillStore } from '../db/skillStore';
import type { ISpaceStore } from '../db/spaceStore';
import type { WithTransaction } from '../db/transaction';
import type { ITurnArtifactStore } from '../db/turnArtifactStore';
import type { IOAuthTokenStore } from '../mcp/auth/types';
import { buildPersonaContext } from '../personas/persona';
import {
  createScheduleRoute,
  createScheduleRunRoute,
  deleteScheduleRoute,
  executeScheduleRunRoute,
  getScheduleRoute,
  getScheduleToolsRoute,
  listScheduleRunsRoute,
  listSchedulesRoute,
  putScheduleRoute,
  putScheduleToolsRoute,
} from '../routes/scheduleRoutes';
import type { ActiveTurnRegistry } from '../runtime/activeTurns';
import {
  chatAssistantAgentName,
  ChatAssistantUnavailableError,
  getOrCreateChatAssistantAgent,
  scheduleRunsAs,
} from '../runtime/chatAssistant';
import { validateManifest } from '../runtime/cron';
import type { EventSubscriptionRegistry } from '../runtime/event-subscription';
import { createMemoryClient } from '../runtime/memory/createMemoryClient';
import { resolveMemoryProvider } from '../runtime/memory/memoryProvider';
import { deliverReminder, ReminderAgentNotFoundError } from '../runtime/reminderDelivery';
import { scheduleToolsOf, specWithTools } from '../runtime/scheduleTools';
import { resolveSandboxProvider, validateAgentSpec } from '../runtime/sessionResources';
import type { TokenFactoryBudget } from '../runtime/tokenFactoryBudget';
import type { TurnDrainRegistry } from '../runtime/turnDrains';
import type { Schedule, ScheduleRun } from '../schemas/schedule';
import { agentIfAccessible, canReadAgentBoundResource, resolveManagedAgentIds } from './agentAccess';
import { getTurnExecutionError, startTurnInProcess } from './turns';

/** Runtime + Context store resolvers needed to start a schedule turn. */
export interface ScheduleTurnExecutionDeps<TTransaction> {
  mcpCatalog: McpCatalog;
  scheduleStore: IScheduleStore<TTransaction>;
  /** A morning brief run leaves out the items the owner already marked done. */
  briefItemStore: IBriefItemCompletionStore;
  sessions: Sessions<SessionCustom, TurnCustom>;
  activeTurns: ActiveTurnRegistry;
  /** Tracks in-flight turn event drains so shutdown can wait for them. */
  turnDrains: TurnDrainRegistry;
  eventSubscriptions: EventSubscriptionRegistry<TurnStreamingEvent>;
  logger: Logger;
  resolveModelProviderStore: (c: Context, runAsAgent?: AgentRecord) => IModelProviderStore<TTransaction>;
  resolveMcpServerStore: (c: Context, runAsAgent?: AgentRecord) => IMcpServerWithAuthStore<TTransaction>;
  resolveSandboxProviderStore: (c: Context) => ISandboxProviderStore<TTransaction>;
  /** Full store (not just `resolveTurnSkills`): a scheduled run resolves git skills exactly like a chat turn. */
  resolveSkillStore: (c: Context) => ISkillStore<TTransaction>;
  /** Persistence agent store (schedule agent binding is not caller-scoped). */
  agentStore: IAgentStore<TTransaction>;
  /** A run answers as the persona its chat had, with the owner's personalization, like a chat turn. */
  personaStore: Pick<IPersonaStore<TTransaction>, 'getPersona'>;
  personalizationStore: Pick<IPersonalizationStore<TTransaction>, 'getProfile'>;
  /**
   * Fork-only, mirroring `TurnsRouterDeps`: not agent-scoped upstream, so these stay directly
   * injected rather than resolved per-request. Required so a scheduled run resolves memory and
   * repository binding exactly like a chat turn.
   */
  tokenStore: IOAuthTokenStore<TTransaction>;
  repositoryStore: IRepositoryStore<TTransaction>;
  sessionStore: ISessionStore<SessionCustom, TurnCustom> & ICompletedTurnEventStore;
  spaceStore: ISpaceStore<TTransaction>;
  /** Per-user Google logins; absent, no Gmail tools mount. */
  googleConnectionStore?: IGoogleConnectionStore | undefined;
  /** persists run_code's harvested result files as turn artifacts at harvest time. */
  turnArtifactStore: ITurnArtifactStore<TTransaction>;
  /** Same override point as `TurnsRouterDeps.sandboxProviderResolver`; defaults to {@link resolveSandboxProvider}. */
  sandboxProviderResolver?: typeof resolveSandboxProvider | undefined;
  /** Not tenant-scoped: the persisted live tool-output screen override is global. */
  globalSettingsStore: IGlobalSettingsStore<TTransaction>;
  /** Scheduled runs on Token Factory count against the same daily cap as chat turns. */
  tokenFactoryBudget: TokenFactoryBudget;
}

export interface SchedulesRouterDeps<TTransaction> extends ScheduleTurnExecutionDeps<TTransaction> {
  resolveAgentStore: (c: Context) => IAgentStore<TTransaction>;
  withTransaction: WithTransaction<TTransaction>;
  resolveRequestContext: ResolveRequestContext;
  authorizer: Authorizer;
}

/**
 * Prepare and start a schedule run using Context-based store resolvers. Caller must set
 * `request_context` (typically via {@link requestContextFromCreatedBySubject})
 * before calling.
 */
export async function startScheduleRunOnRequest<TTransaction>(params: {
  c: Context;
  item: ScheduleDispatchItem;
  deps: ScheduleTurnExecutionDeps<TTransaction>;
}): Promise<void> {
  const { c, item, deps } = params;
  if (item.schedule.manifest.kind === 'reminder') {
    // A reminder needs no model: the host writes its line into the Reminders chat itself.
    await deliverReminder({
      item,
      sessions: deps.sessions,
      sessionStore: deps.sessionStore,
      agentStore: deps.agentStore,
      now: new Date(),
    });
    return;
  }
  const prepared = await startScheduleRun({
    item,
    sessions: deps.sessions,
    agentStore: deps.agentStore,
    personaStore: deps.personaStore,
    briefItems: deps.briefItemStore,
  });
  if (prepared === undefined) {
    return;
  }
  const personalizationProfile = await deps.personalizationStore.getProfile({
    tenant_id: item.schedule.tenant_id,
    created_by: prepared.userRef,
  });
  // Memory wiring mirrors the chat route: without a client the turn retains nothing, so
  // a scheduled agent's turns are never summarized and never reach the Memories page.
  // The markdown backend needs no provider lookup; hindsight resolves one like chat does.
  const memoryProvider =
    configuration.MEMORY_BACKEND === 'hindsight'
      ? await resolveMemoryProvider({
          mcpServerStore: deps.resolveMcpServerStore(c, prepared.agent),
          tokenStore: deps.tokenStore,
          tenantId: item.schedule.tenant_id,
          clientName: configuration.MCP_DCR_OAUTH_CLIENT_NAME,
          userRef: prepared.userRef,
          logger: deps.logger,
        })
      : undefined;
  const memoryClient = createMemoryClient({
    backend: configuration.MEMORY_BACKEND,
    markdownDir: configuration.MEMORY_MARKDOWN_DIR,
    namespace: item.schedule.tenant_id,
    vaultScope:
      prepared.persona === undefined
        ? undefined
        : { personaName: prepared.persona.display_name, personaId: prepared.persona.id },
    hindsight:
      memoryProvider === undefined
        ? undefined
        : { apiBase: memoryProvider.apiBase, bank: memoryProvider.bank, headers: memoryProvider.headers },
    // Same meaning-based recall wiring as the chat route: one subsystem singleton per
    // vault, degrading to keyword-only until the model is ready.
    embeddings: configuration.MEMORY_EMBEDDINGS_ENABLED
      ? {
          modelDir: configuration.MEMORY_EMBEDDINGS_MODEL_DIR,
          batchSize: configuration.MEMORY_EMBEDDINGS_BACKFILL_BATCH_SIZE,
          log: (message: string) => deps.logger.info(message),
        }
      : undefined,
  });
  await startTurnInProcess({
    session: prepared.session,
    input: prepared.input,
    previous_turn_id: prepared.previous_turn_id,
    userRef: prepared.userRef,
    // Nobody watches a scheduled run, so it holds what would ask instead of stopping at a card.
    unattended: true,
    deps: {
      mcpCatalog: deps.mcpCatalog,
      activeTurns: deps.activeTurns,
      turnDrains: deps.turnDrains,
      eventSubscriptions: deps.eventSubscriptions,
      agentStore: deps.agentStore,
      modelProviderStore: deps.resolveModelProviderStore(c, prepared.agent),
      mcpServerStore: deps.resolveMcpServerStore(c, prepared.agent),
      sandboxProviderStore: deps.resolveSandboxProviderStore(c),
      skillStore: deps.resolveSkillStore(c),
      tokenStore: deps.tokenStore,
      repositoryStore: deps.repositoryStore,
      sessionStore: deps.sessionStore,
      spaceStore: deps.spaceStore,
      googleConnectionStore: deps.googleConnectionStore,
      turnArtifactStore: deps.turnArtifactStore,
      sandboxProviderResolver: deps.sandboxProviderResolver,
      globalSettingsStore: deps.globalSettingsStore,
      tokenFactoryBudget: deps.tokenFactoryBudget,
      personalizationProfile,
      personaContext: prepared.persona === undefined ? undefined : buildPersonaContext(prepared.persona),
      memoryClient,
      memoryProviderServerName: memoryProvider?.serverName,
      memorySettings: memoryProvider?.settings,
      logger: deps.logger,
      // A scheduled run has no browser, so its day and times follow the schedule's own time zone.
      clientTimezone: item.schedule.manifest.timezone,
    },
  });
}

function toWireSchedule(record: ScheduleRecord, runsAs: string): Schedule {
  return {
    id: record.id,
    agent_name: record.agent_name,
    runs_as: runsAs,
    name: record.name,
    manifest: record.manifest,
    created_by_subject: record.created_by_subject,
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
}

/** Wire schedules with the same plain "runs as" name the chat shows. */
async function toWireSchedules<TTransaction>(input: {
  records: readonly ScheduleRecord[];
  tenant_id: string;
  deps: ScheduleTurnExecutionDeps<TTransaction>;
}): Promise<Schedule[]> {
  const runsAs = scheduleRunsAs({
    tenant_id: input.tenant_id,
    agentStore: input.deps.agentStore,
    personaStore: input.deps.personaStore,
    personalizationStore: input.deps.personalizationStore,
  });
  return Promise.all(input.records.map(async record => toWireSchedule(record, await runsAs(record))));
}

async function toWireOneSchedule<TTransaction>(input: {
  record: ScheduleRecord;
  tenant_id: string;
  deps: ScheduleTurnExecutionDeps<TTransaction>;
}): Promise<Schedule> {
  const [wire] = await toWireSchedules({ records: [input.record], tenant_id: input.tenant_id, deps: input.deps });
  if (wire === undefined) {
    throw new Error('A schedule could not be shown.');
  }
  return wire;
}

function toWireScheduleRun(record: ScheduleRunRecord): ScheduleRun {
  return {
    id: record.id,
    schedule_id: record.schedule_id,
    name: record.name,
    scheduled_for: record.scheduled_for,
    status: record.status,
    created_by_subject: record.created_by_subject,
    triggered_at: record.triggered_at,
    reason: record.reason,
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
}

const FORBIDDEN_SCHEDULE_ACCESS = 'Only the schedule creator can access this schedule';

/** Schedule mutations remain creator-only in every auth mode. */
function isScheduleOwner(requestContext: Pick<RequestContext, 'subject'>, created_by_subject_id: string): boolean {
  return requestContext.subject.id === created_by_subject_id;
}

export function createScheduleExecutionRouter<TTransaction>(deps: ScheduleTurnExecutionDeps<TTransaction>) {
  const handler: RouteHandler<typeof executeScheduleRunRoute> = async c => {
    const { schedule_run_id: scheduleRunId } = c.req.valid('json');
    try {
      const item = await loadScheduleDispatchItem({
        scheduleRunId,
        scheduleStore: deps.scheduleStore,
      });
      c.set(
        'request_context',
        requestContextFromCreatedBySubject({
          tenant_id: item.schedule.tenant_id,
          created_by_subject: item.schedule.created_by_subject,
        }),
      );
      await startScheduleRunOnRequest({ c, item, deps });
    } catch (error) {
      if (
        error instanceof ScheduleRunNotFoundError ||
        error instanceof ScheduleNotFoundError ||
        error instanceof ScheduleAgentNotFoundError ||
        error instanceof SchedulePersonaNotFoundError ||
        error instanceof ReminderAgentNotFoundError
      ) {
        return c.json({ error: { message: error.message } }, 404);
      }
      throw error;
    }
    return c.body(null, 204);
  };

  const router = new OpenAPIHono();
  router.openapi(executeScheduleRunRoute, handler);
  return router;
}

export function createSchedulesRouter<TTransaction>(deps: SchedulesRouterDeps<TTransaction>) {
  const listHandler: RouteHandler<typeof listSchedulesRoute> = async c => {
    const { agent_names: agentNames, limit, page_token: pageToken, created_by_me: createdByMe } = c.req.valid('query');
    const requestContext = deps.resolveRequestContext(c);
    try {
      const managedAgentIds = createdByMe
        ? []
        : await resolveManagedAgentIds({
            store: deps.resolveAgentStore(c),
            context: requestContext,
            authorizer: deps.authorizer,
          });
      const { data, pagination } = await deps.scheduleStore.listSchedules({
        tenant_id: requestContext.tenant_id,
        limit,
        page_token: pageToken,
        agent_names: agentNames,
        created_by_or_agent_ids: {
          created_by_subject_id: requestContext.subject.id,
          agent_ids: managedAgentIds,
        },
      });
      const wire = await toWireSchedules({ records: data, tenant_id: requestContext.tenant_id, deps });
      return c.json({ data: wire, pagination }, 200);
    } catch (error) {
      if (error instanceof InvalidPageTokenError) {
        return c.json({ error: { message: error.message } }, 400);
      }
      throw error;
    }
  };

  const listRunsHandler: RouteHandler<typeof listScheduleRunsRoute> = async c => {
    const { schedule_id: scheduleId } = c.req.valid('param');
    const { limit, page_token: pageToken } = c.req.valid('query');
    const requestContext = deps.resolveRequestContext(c);
    const schedule = await deps.scheduleStore.getSchedule({
      tenant_id: requestContext.tenant_id,
      id: scheduleId,
    });
    if (schedule === undefined) {
      return c.json({ error: { message: `Schedule not found: ${scheduleId}` } }, 404);
    }
    if (
      !(await canReadAgentBoundResource({
        store: deps.resolveAgentStore(c),
        context: requestContext,
        authorizer: deps.authorizer,
        agent_id: schedule.agent_id,
        created_by_subject_id: schedule.created_by_subject.subject_id,
      }))
    ) {
      return c.json({ error: { message: FORBIDDEN_SCHEDULE_ACCESS } }, 403);
    }
    try {
      const { data, pagination } = await deps.scheduleStore.listRuns({
        tenant_id: requestContext.tenant_id,
        schedule_id: scheduleId,
        limit,
        page_token: pageToken,
      });
      return c.json({ data: data.map(toWireScheduleRun), pagination }, 200);
    } catch (error) {
      if (error instanceof InvalidPageTokenError) {
        return c.json({ error: { message: error.message } }, 400);
      }
      throw error;
    }
  };

  const createScheduleRunHandler: RouteHandler<typeof createScheduleRunRoute> = async c => {
    const { schedule_id: scheduleId } = c.req.valid('json');
    const requestContext = deps.resolveRequestContext(c);

    const schedule = await deps.scheduleStore.getSchedule({
      tenant_id: requestContext.tenant_id,
      id: scheduleId,
    });
    if (schedule === undefined) {
      return c.json({ error: { message: `Schedule not found: ${scheduleId}` } }, 404);
    }
    if (!isScheduleOwner(requestContext, schedule.created_by_subject.subject_id)) {
      return c.json({ error: { message: FORBIDDEN_SCHEDULE_ACCESS } }, 403);
    }

    // Schedule ownership alone must not invoke an agent the caller cannot use.
    const agent = await agentIfAccessible({
      authorizer: deps.authorizer,
      context: requestContext,
      action: 'use',
      agent: await deps.resolveAgentStore(c).getAgent({
        tenant_id: requestContext.tenant_id,
        name: schedule.agent_name,
      }),
    });
    if (agent === undefined) {
      return c.json({ error: { message: `Agent not found: ${schedule.agent_name}` } }, 404);
    }

    const now = new Date();
    let run: ScheduleRunRecord;
    try {
      run = await deps.scheduleStore.createRun({
        tenant_id: requestContext.tenant_id,
        schedule_id: schedule.id,
        name: manualRunName(),
        scheduled_for: now,
        status: 'triggered',
        created_by_subject: createdBySubjectFromRequestContext(requestContext),
        triggered_at: now,
      });
    } catch (error) {
      if (error instanceof ScheduleRunConflictError) {
        return c.json({ error: { message: `${error.message}. Retry the request.` } }, 409);
      }
      throw error;
    }

    try {
      await startScheduleRunOnRequest({ c, item: { run, schedule }, deps });
    } catch (error) {
      await deps.scheduleStore.updateRunStatus({
        tenant_id: requestContext.tenant_id,
        id: run.id,
        status: 'failed',
        reason: scheduleRunFailureReason(error),
      });

      if (
        error instanceof ScheduleRunNotFoundError ||
        error instanceof ScheduleNotFoundError ||
        error instanceof ScheduleAgentNotFoundError ||
        error instanceof SchedulePersonaNotFoundError ||
        error instanceof ReminderAgentNotFoundError
      ) {
        return c.json({ error: { message: error.message } }, 404);
      }
      const turnError = getTurnExecutionError(error);
      if (turnError) {
        return c.json({ error: { message: turnError.message } }, turnError.status);
      }
      throw error;
    }

    const latest = await deps.scheduleStore.getRun({
      tenant_id: requestContext.tenant_id,
      id: run.id,
    });
    return c.json({ data: toWireScheduleRun(latest ?? run) }, 201);
  };

  const createHandler: RouteHandler<typeof createScheduleRoute> = async c => {
    const body = c.req.valid('json');
    const requestContext = deps.resolveRequestContext(c);

    validateManifest(body.manifest);

    const agent = await agentIfAccessible({
      authorizer: deps.authorizer,
      context: requestContext,
      action: 'use',
      agent: await deps.resolveAgentStore(c).getAgent({ tenant_id: requestContext.tenant_id, name: body.agent_name }),
    });
    if (agent === undefined) {
      return c.json({ error: { message: `Agent not found: ${body.agent_name}` } }, 404);
    }

    let record: ScheduleRecord;
    try {
      record = await deps.withTransaction(async transaction => {
        const { schedule } = await deps.scheduleStore.createScheduleAndRun(
          {
            tenant_id: requestContext.tenant_id,
            agent_id: agent.id,
            agent_name: agent.name,
            name: body.name,
            persona_id: null,
            manifest: body.manifest,
            created_by_subject: createdBySubjectFromRequestContext(requestContext),
            runFrom: new Date(),
          },
          transaction,
        );
        return schedule;
      });
    } catch (error) {
      if (error instanceof ScheduleNameConflictError) {
        return c.json({ error: { message: error.message } }, 409);
      }
      if (error instanceof ScheduleRunConflictError) {
        return c.json({ error: { message: `${error.message}. Retry the request.` } }, 409);
      }
      throw error;
    }

    return c.json({ data: await toWireOneSchedule({ record, tenant_id: requestContext.tenant_id, deps }) }, 201);
  };

  const getHandler: RouteHandler<typeof getScheduleRoute> = async c => {
    const { schedule_id: scheduleId } = c.req.valid('param');
    const requestContext = deps.resolveRequestContext(c);
    const record = await deps.scheduleStore.getSchedule({
      tenant_id: requestContext.tenant_id,
      id: scheduleId,
    });
    if (record === undefined) {
      return c.json({ error: { message: `Schedule not found: ${scheduleId}` } }, 404);
    }
    if (
      !(await canReadAgentBoundResource({
        store: deps.resolveAgentStore(c),
        context: requestContext,
        authorizer: deps.authorizer,
        agent_id: record.agent_id,
        created_by_subject_id: record.created_by_subject.subject_id,
      }))
    ) {
      return c.json({ error: { message: FORBIDDEN_SCHEDULE_ACCESS } }, 403);
    }
    return c.json({ data: await toWireOneSchedule({ record, tenant_id: requestContext.tenant_id, deps }) }, 200);
  };

  /**
   * Replaces the whole document, like every other manifest PUT in this server: an
   * omitted optional field is not "left alone", it returns to its default — omitting
   * `status` re-activates a paused schedule, omitting `timezone` moves it to UTC.
   * Read-modify-write if that is not what you want.
   *
   * Agent binding is immutable — a schedule that should point at a different agent is
   * a different schedule. `name` is editable but must stay unique within the agent;
   * renaming onto a taken name is a 409.
   */
  const putHandler: RouteHandler<typeof putScheduleRoute> = async c => {
    const { schedule_id: scheduleId } = c.req.valid('param');
    const body = c.req.valid('json');
    const requestContext = deps.resolveRequestContext(c);

    validateManifest(body.manifest);

    const existing = await deps.scheduleStore.getSchedule({
      tenant_id: requestContext.tenant_id,
      id: scheduleId,
    });
    if (existing === undefined) {
      return c.json({ error: { message: `Schedule not found: ${scheduleId}` } }, 404);
    }
    if (!isScheduleOwner(requestContext, existing.created_by_subject.subject_id)) {
      return c.json({ error: { message: FORBIDDEN_SCHEDULE_ACCESS } }, 403);
    }

    let record: ScheduleRecord | undefined;
    try {
      record = await deps.withTransaction(async transaction => {
        const result = await deps.scheduleStore.updateScheduleAndRun(
          {
            tenant_id: requestContext.tenant_id,
            id: scheduleId,
            name: body.name,
            manifest: body.manifest,
            runFrom: new Date(),
          },
          transaction,
        );
        return result?.schedule;
      });
    } catch (error) {
      if (error instanceof ScheduleNameConflictError) {
        return c.json({ error: { message: error.message } }, 409);
      }
      if (error instanceof ScheduleRunConflictError) {
        return c.json({ error: { message: `${error.message}. Retry the request.` } }, 409);
      }
      throw error;
    }

    if (record === undefined) {
      return c.json({ error: { message: `Schedule not found: ${scheduleId}` } }, 404);
    }
    return c.json({ data: await toWireOneSchedule({ record, tenant_id: requestContext.tenant_id, deps }) }, 200);
  };

  /** The agent a schedule is bound to, which holds the tools it runs with. */
  const scheduleAgent = async (record: ScheduleRecord): Promise<AgentRecord | undefined> =>
    deps.agentStore.getAgent({ tenant_id: record.tenant_id, id: record.agent_id });

  const getToolsHandler: RouteHandler<typeof getScheduleToolsRoute> = async c => {
    const { schedule_id: scheduleId } = c.req.valid('param');
    const requestContext = deps.resolveRequestContext(c);
    const record = await deps.scheduleStore.getSchedule({ tenant_id: requestContext.tenant_id, id: scheduleId });
    if (record === undefined) {
      return c.json({ error: { message: `Schedule not found: ${scheduleId}` } }, 404);
    }
    if (
      !(await canReadAgentBoundResource({
        store: deps.resolveAgentStore(c),
        context: requestContext,
        authorizer: deps.authorizer,
        agent_id: record.agent_id,
        created_by_subject_id: record.created_by_subject.subject_id,
      }))
    ) {
      return c.json({ error: { message: FORBIDDEN_SCHEDULE_ACCESS } }, 403);
    }
    const agent = await scheduleAgent(record);
    if (agent === undefined) {
      return c.json({ error: { message: `Agent not found: ${record.agent_name}` } }, 404);
    }
    return c.json({ data: scheduleToolsOf({ schedule: record, agent }) }, 200);
  };

  /**
   * Gives the schedule its own agent built from its current one with only the tools swapped, then points the
   * schedule at it. A saved agent is never edited, because other chats and schedules use it. The agent is made
   * the way a chat schedule's is, so schedules with the same setup share it.
   */
  const putToolsHandler: RouteHandler<typeof putScheduleToolsRoute> = async c => {
    const { schedule_id: scheduleId } = c.req.valid('param');
    const tools = c.req.valid('json');
    const requestContext = deps.resolveRequestContext(c);
    const existing = await deps.scheduleStore.getSchedule({ tenant_id: requestContext.tenant_id, id: scheduleId });
    if (existing === undefined) {
      return c.json({ error: { message: `Schedule not found: ${scheduleId}` } }, 404);
    }
    if (!isScheduleOwner(requestContext, existing.created_by_subject.subject_id)) {
      return c.json({ error: { message: FORBIDDEN_SCHEDULE_ACCESS } }, 403);
    }
    const current = await scheduleAgent(existing);
    if (current === undefined) {
      return c.json({ error: { message: `Agent not found: ${existing.agent_name}` } }, 404);
    }
    if (scheduleToolsOf({ schedule: existing, agent: current }).source === 'saved_agent') {
      return c.json(
        {
          error: {
            message: `The tools of this schedule come from the agent ${current.name}. Change them on that agent's page.`,
          },
        },
        409,
      );
    }
    if (tools.skills.length > 0 && !tools.sandbox_enabled) {
      return c.json({ error: { message: 'Skills need the sandbox. Turn the sandbox on or remove the skills.' } }, 422);
    }
    const next = specWithTools({ spec: current.manifest, tools });
    if (!next.ok) {
      return c.json({ error: { message: next.message } }, 422);
    }
    try {
      await validateAgentSpec({
        spec: next.spec,
        tenant_id: requestContext.tenant_id,
        modelProviderStore: deps.resolveModelProviderStore(c, current),
        mcpServerStore: deps.resolveMcpServerStore(c, current),
        skillStore: deps.resolveSkillStore(c),
        sandboxProviderStore: deps.resolveSandboxProviderStore(c),
        searchProviderPresetNames: deps.mcpCatalog.searchProviderPresetNames(),
      });
    } catch (error) {
      if (error instanceof HTTPException && error.status === 422) {
        return c.json(
          { error: { message: `${error.message}. Pick from the tools the form lists, then save again.` } },
          422,
        );
      }
      throw error;
    }
    let agent: AgentRecord;
    try {
      agent = await getOrCreateChatAssistantAgent({
        tenant_id: requestContext.tenant_id,
        owner: existing.created_by_subject,
        name: chatAssistantAgentName({ owner: existing.created_by_subject, spec: next.spec }),
        spec: next.spec,
        agentStore: deps.agentStore,
      });
    } catch (error) {
      if (error instanceof ChatAssistantUnavailableError) {
        return c.json({ error: { message: error.message } }, 409);
      }
      throw error;
    }

    let record: ScheduleRecord | undefined;
    try {
      record = await deps.withTransaction(async transaction => {
        const result = await deps.scheduleStore.updateScheduleAndRun(
          {
            tenant_id: requestContext.tenant_id,
            id: scheduleId,
            name: existing.name,
            manifest: existing.manifest,
            agent: { agent_id: agent.id, agent_name: agent.name },
            runFrom: new Date(),
          },
          transaction,
        );
        return result?.schedule;
      });
    } catch (error) {
      if (error instanceof ScheduleNameConflictError) {
        return c.json(
          {
            error: {
              message: 'You already have a schedule with this name and these tools. Rename one, then try again.',
            },
          },
          409,
        );
      }
      throw error;
    }
    if (record === undefined) {
      return c.json({ error: { message: `Schedule not found: ${scheduleId}` } }, 404);
    }
    return c.json({ data: scheduleToolsOf({ schedule: record, agent }) }, 200);
  };

  const deleteHandler: RouteHandler<typeof deleteScheduleRoute> = async c => {
    const { schedule_id: scheduleId } = c.req.valid('param');
    const requestContext = deps.resolveRequestContext(c);
    const record = await deps.scheduleStore.getSchedule({
      tenant_id: requestContext.tenant_id,
      id: scheduleId,
    });
    if (record === undefined) {
      return c.json({}, 200);
    }
    if (!isScheduleOwner(requestContext, record.created_by_subject.subject_id)) {
      return c.json({ error: { message: FORBIDDEN_SCHEDULE_ACCESS } }, 403);
    }
    await deps.scheduleStore.deleteSchedule({
      tenant_id: requestContext.tenant_id,
      id: scheduleId,
    });
    return c.json({}, 200);
  };

  const router = new OpenAPIHono();
  router.openapi(listSchedulesRoute, listHandler);
  router.openapi(listScheduleRunsRoute, listRunsHandler);
  router.openapi(createScheduleRunRoute, createScheduleRunHandler);
  router.openapi(createScheduleRoute, createHandler);
  router.openapi(getScheduleRoute, getHandler);
  router.openapi(putScheduleRoute, putHandler);
  router.openapi(getScheduleToolsRoute, getToolsHandler);
  router.openapi(putScheduleToolsRoute, putToolsHandler);
  router.openapi(deleteScheduleRoute, deleteHandler);
  return router;
}

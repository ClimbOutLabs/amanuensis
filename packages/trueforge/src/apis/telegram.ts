/**
 * Telegram APIs: the Settings card endpoints (browser session only, admin only, under
 * /api/v1/user/settings/telegram), the internal endpoint the controller hands polled updates to
 * (/api/internal/telegram), and the webhook Telegram posts to when a public https address is
 * configured (/api/telegram). The bot token arrives only on the connect call, passes to the
 * connection store, and is never logged or returned.
 */
import { OpenAPIHono, type RouteHandler } from '@hono/zod-openapi';
import { AgentSpecSchema, type SessionHandle, type TurnInputItem } from '@truefoundry/trueforge-core/agent-session';
import type { Context, MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { Logger } from 'winston';

import {
  createdBySubjectFromRequestContext,
  requestContextFromCreatedBySubject,
  type ResolveRequestContext,
} from '../auth/identity';
import configuration from '../config';
import type { AgentRecord } from '../db/agentStore';
import type { IPersonalizationStore } from '../db/personalizationStore';
import type { SessionCustom, TurnCustom } from '../db/sessionCustom';
import type { ITelegramStore, TelegramConnection } from '../db/telegramStore';
import {
  cancelTelegramPairingRoute,
  confirmTelegramPairingRoute,
  connectTelegramRoute,
  getTelegramStatusRoute,
  processTelegramUpdateRoute,
  removeTelegramRoute,
  telegramWebhookRoute,
} from '../routes/telegramRoutes';
import { chatAssistantAgentName, getOrCreateChatAssistantAgent } from '../runtime/chatAssistant';
import { resolveDefaultChatModel } from '../runtime/defaultChatModel';
import { createMemoryClient } from '../runtime/memory/createMemoryClient';
import {
  createTelegramRefusalThrottle,
  processTelegramUpdate,
  TELEGRAM_CHAT_TITLE,
  TELEGRAM_METADATA_KEY,
  telegramExternalId,
  type TelegramTurnPort,
} from '../runtime/telegram/telegramChannel';
import { sendTelegramText, type TelegramSendQueue } from '../runtime/telegram/telegramSendQueue';
import { TelegramSettingsError, type TelegramService } from '../runtime/telegram/telegramService';
import { TelegramUpdateSchema, type TelegramUpdate } from '../schemas/telegram';
import { readServerSandboxAvailable } from './capabilities';
import { requireJsonOrSameOrigin } from './crossSite';
import type { ScheduleTurnExecutionDeps } from './schedules';
import { startTurnInProcess } from './turns';

export const TELEGRAM_SETTINGS_BASE_PATH = '/api/v1/user/settings/telegram';
export const TELEGRAM_WEBHOOK_BASE_PATH = '/api/telegram';

/** Runtime + store resolvers needed to run Telegram turns and move its updates, mirroring the schedule execution deps. */
export interface TelegramTurnExecutionDeps<TTransaction> extends Omit<
  ScheduleTurnExecutionDeps<TTransaction>,
  'scheduleStore' | 'briefItemStore' | 'deliveryService' | 'personalizationStore'
> {
  /** Read for the owner's profile, and written by profile learning after a message they sent. */
  personalizationStore: IPersonalizationStore<TTransaction>;
  telegramStore: ITelegramStore;
  telegramService: TelegramService;
  telegramQueue: TelegramSendQueue;
}

/** Thrown when the instance has no model yet, so a Telegram turn cannot run. */
export class TelegramModelUnavailableError extends Error {
  constructor() {
    super('No model is configured yet.');
    this.name = 'TelegramModelUnavailableError';
  }
}

function ownerOf(connection: TelegramConnection): { tenant_id: string; created_by: string } {
  return { tenant_id: connection.tenant_id, created_by: connection.created_by };
}

/**
 * The Telegram chat for this owner: made on the first message and reused after, bound to the
 * owner's own assistant agent (the one a plain chat's schedules run as), built from the default
 * model. The chat is titled Telegram and marked, so the app shows it as its own chat.
 */
async function telegramSession<TTransaction>(params: {
  c: Context;
  deps: TelegramTurnExecutionDeps<TTransaction>;
  connection: TelegramConnection;
}): Promise<{ session: SessionHandle<SessionCustom, TurnCustom>; previous_turn_id: string }> {
  const { c, deps, connection } = params;
  const owner = connection.created_by_subject;
  const tenant_id = connection.tenant_id;
  const modelName = await resolveDefaultChatModel({
    tenantId: tenant_id,
    modelProviderStore: deps.resolveModelProviderStore(c),
    globalSettingsStore: deps.globalSettingsStore,
    logger: deps.logger,
  });
  if (modelName === undefined) {
    throw new TelegramModelUnavailableError();
  }
  const sandboxAvailable = await readServerSandboxAvailable({
    store: deps.resolveSandboxProviderStore(c),
    tenant_id,
    logger: deps.logger,
  });
  // The owner's plain-chat assistant agent, the same one a chat here with the default model runs as.
  const spec = AgentSpecSchema.parse({
    model: { name: modelName },
    config: { sandbox: { enabled: sandboxAvailable } },
  });
  const agent = await getOrCreateChatAssistantAgent({
    tenant_id,
    owner,
    name: chatAssistantAgentName({ owner, spec }),
    spec,
    agentStore: deps.agentStore,
  });
  const { session, created } = await deps.sessions.getOrCreateByExternalId({
    tenant_id,
    external_id: telegramExternalId(owner.subject_id),
    created_by_subject: owner,
    agent: { type: 'reference', id: agent.id, name: agent.name },
    metadata: { [TELEGRAM_METADATA_KEY]: 'true' },
  });
  if (created || session.record.title === null) {
    await deps.sessionStore.updateSession({
      tenant_id,
      session_id: session.session_id,
      agent: undefined,
      title: TELEGRAM_CHAT_TITLE,
      metadata: undefined,
    });
  }
  if (connection.session_id !== session.session_id) {
    await deps.telegramStore.setSessionId({ ...ownerOf(connection), session_id: session.session_id });
  }
  return { session, previous_turn_id: session.record.last_turn_id ?? 'none' };
}

/** Starts one turn in the Telegram chat, wired like a schedule run but attended: what would ask, asks. */
async function startTelegramTurn<TTransaction>(params: {
  c: Context;
  deps: TelegramTurnExecutionDeps<TTransaction>;
  connection: TelegramConnection;
  session: SessionHandle<SessionCustom, TurnCustom>;
  input: TurnInputItem[];
  previous_turn_id: string;
}): Promise<{ session_id: string; turn_id: string }> {
  const { c, deps, connection, session, input, previous_turn_id } = params;
  const tenant_id = connection.tenant_id;
  const userRef = connection.created_by;
  const personalizationProfile = await deps.personalizationStore.getProfile({ tenant_id, created_by: userRef });
  // The session's own agent, so the per-request stores resolve as its runs do, like a schedule run's.
  const agent: AgentRecord | undefined =
    session.record.agent.type === 'reference'
      ? await deps.agentStore.getAgent({ tenant_id, id: session.record.agent.id })
      : undefined;
  // Memory wiring mirrors the chat route: without a client the turn retains nothing.
  const memoryClient = createMemoryClient({
    markdownDir: configuration.MEMORY_MARKDOWN_DIR,
    namespace: tenant_id,
    vaultScope: undefined,
    embeddings: configuration.MEMORY_EMBEDDINGS_ENABLED
      ? {
          modelDir: configuration.MEMORY_EMBEDDINGS_MODEL_DIR,
          batchSize: configuration.MEMORY_EMBEDDINGS_BACKFILL_BATCH_SIZE,
          log: (message: string) => deps.logger.info(message),
        }
      : undefined,
  });
  const turn = await startTurnInProcess({
    session,
    input,
    previous_turn_id,
    userRef,
    // The person wrote this message, so their profile learns from it as it does from a chat here.
    profileLearning: { personalizationStore: deps.personalizationStore },
    deps: {
      mcpCatalog: deps.mcpCatalog,
      activeTurns: deps.activeTurns,
      turnDrains: deps.turnDrains,
      eventSubscriptions: deps.eventSubscriptions,
      agentStore: deps.agentStore,
      modelProviderStore: deps.resolveModelProviderStore(c, agent),
      mcpServerStore: deps.resolveMcpServerStore(c, agent),
      sandboxProviderStore: deps.resolveSandboxProviderStore(c),
      skillStore: deps.resolveSkillStore(c),
      tokenStore: deps.tokenStore,
      repositoryStore: deps.repositoryStore,
      sentinelSettingsStore: deps.sentinelSettingsStore,
      sessionStore: deps.sessionStore,
      spaceStore: deps.spaceStore,
      googleConnectionStore: deps.googleConnectionStore,
      turnArtifactStore: deps.turnArtifactStore,
      sandboxProviderResolver: deps.sandboxProviderResolver,
      globalSettingsStore: deps.globalSettingsStore,
      tokenFactoryBudget: deps.tokenFactoryBudget,
      chatDeletionStore: deps.chatDeletionStore,
      chatSearchIndexer: deps.chatSearchIndexer,
      personalizationProfile,
      personaContext: undefined,
      memoryClient,
      logger: deps.logger,
      clientTimezone: undefined,
    },
  });
  return { session_id: session.session_id, turn_id: turn.id };
}

/** The turn port the channel talks to, bound to one request so its stores resolve as the owner. */
export function createTelegramTurnPort<TTransaction>(params: {
  c: Context;
  deps: TelegramTurnExecutionDeps<TTransaction>;
}): TelegramTurnPort {
  const { c, deps } = params;
  return {
    async startMessageTurn({ connection, input }) {
      const { session, previous_turn_id } = await telegramSession({ c, deps, connection });
      return startTelegramTurn({ c, deps, connection, session, input, previous_turn_id });
    },
    async submitApproval({ connection, approval, decision }) {
      const session = await deps.sessions.get({ tenant_id: connection.tenant_id, session_id: approval.session_id });
      if (session === undefined) {
        throw new Error('The chat this approval belongs to is not there.');
      }
      return startTelegramTurn({
        c,
        deps,
        connection,
        session,
        input: [
          {
            type: 'user.tool_approval',
            thread_id: approval.thread_id,
            tool_call_id: approval.tool_call_id,
            approval: decision === 'allow' ? { status: 'allow', scope: 'once' } : { status: 'deny' },
          },
        ],
        previous_turn_id: approval.turn_id,
      });
    },
  };
}

/**
 * One refusal throttle for the whole server: the channel deps are rebuilt per call, and the
 * throttle only holds back repeat refusals if it outlives them.
 */
const telegramRefusals = createTelegramRefusalThrottle();

function channelDeps<TTransaction>(params: { c: Context; deps: TelegramTurnExecutionDeps<TTransaction> }) {
  return {
    store: params.deps.telegramStore,
    service: params.deps.telegramService,
    queue: params.deps.telegramQueue,
    turns: createTelegramTurnPort(params),
    logger: params.deps.logger,
    refusals: telegramRefusals,
  };
}

/** The internal endpoint the controller hands polled updates to (mounted at /api/internal/telegram). */
export function createTelegramExecutionRouter<TTransaction>(deps: TelegramTurnExecutionDeps<TTransaction>) {
  const handler: RouteHandler<typeof processTelegramUpdateRoute> = async c => {
    const { connection_id: connectionId, update } = c.req.valid('json');
    const connection = await deps.telegramStore.getConnectionById({ id: connectionId });
    if (connection === undefined) {
      return c.json({ error: { message: 'That Telegram connection is not there.' } }, 404);
    }
    c.set(
      'request_context',
      requestContextFromCreatedBySubject({
        tenant_id: connection.tenant_id,
        created_by_subject: connection.created_by_subject,
      }),
    );
    await processTelegramUpdate(channelDeps({ c, deps }), { connection, update });
    return c.body(null, 204);
  };
  const router = new OpenAPIHono();
  router.openapi(processTelegramUpdateRoute, handler);
  return router;
}

/** One webhook update read from its loosely promised body, or undefined when its shape cannot be read. */
export function readTelegramWebhookUpdate(body: unknown): TelegramUpdate | undefined {
  const parsed = TelegramUpdateSchema.safeParse(body);
  return parsed.success ? parsed.data : undefined;
}

/** The webhook Telegram posts updates to (mounted at /api/telegram). The secret it was given decides. */
/**
 * The webhook's gate, applied before the route sees the call: the body is not even read until
 * the secret Telegram was given at setup checks out, so a call without it is refused as
 * unauthorized whatever it carries. The route handler checks again for itself.
 */
export function createTelegramWebhookSecretMiddleware(deps: { telegramStore: ITelegramStore }): MiddlewareHandler {
  return async (c, next) => {
    const secret = c.req.header('x-telegram-bot-api-secret-token');
    const connection =
      secret === undefined
        ? undefined
        : await deps.telegramStore.getConnectionByWebhookSecret({ webhook_secret: secret });
    if (connection === undefined) {
      throw new HTTPException(401, { message: 'This call did not carry the webhook secret.' });
    }
    return next();
  };
}

export function createTelegramWebhookRouter<TTransaction>(deps: TelegramTurnExecutionDeps<TTransaction>) {
  const handler: RouteHandler<typeof telegramWebhookRoute> = async c => {
    const secret = c.req.header('x-telegram-bot-api-secret-token');
    const connection =
      secret === undefined
        ? undefined
        : await deps.telegramStore.getConnectionByWebhookSecret({ webhook_secret: secret });
    if (connection === undefined) {
      return c.json({ error: { message: 'This call did not carry the webhook secret.' } }, 401);
    }
    c.set(
      'request_context',
      requestContextFromCreatedBySubject({
        tenant_id: connection.tenant_id,
        created_by_subject: connection.created_by_subject,
      }),
    );
    // The route promises only the update id, so the update is checked here, not at the door:
    // one in a shape this build cannot read is dropped with the same 204, because an error
    // answer would make Telegram retry it forever. Polling skips such updates the same way.
    const update = readTelegramWebhookUpdate(c.req.valid('json'));
    if (update === undefined) {
      deps.logger.warn('A Telegram webhook update could not be read and was dropped', {
        connection_id: connection.id,
      });
      return c.body(null, 204);
    }
    await processTelegramUpdate(channelDeps({ c, deps }), { connection, update });
    return c.body(null, 204);
  };
  const router = new OpenAPIHono();
  router.openapi(telegramWebhookRoute, handler);
  return router;
}

export interface TelegramSettingsRouterDeps {
  telegramService: TelegramService;
  telegramStore: ITelegramStore;
  telegramQueue: TelegramSendQueue;
  resolveRequestContext: ResolveRequestContext;
  logger: Logger;
}

/** The Settings Telegram card's endpoints (mounted at /api/v1/user/settings/telegram). */
export function createTelegramSettingsRouter(deps: TelegramSettingsRouterDeps) {
  const router = new OpenAPIHono();
  router.use('/', requireJsonOrSameOrigin());

  const settingsError = (error: unknown) => {
    if (error instanceof TelegramSettingsError) {
      return { body: { error: { message: error.message, type: error.failure } }, status: error.status };
    }
    throw error;
  };

  router.openapi(getTelegramStatusRoute, async c => {
    const requestContext = deps.resolveRequestContext(c);
    const status = await deps.telegramService.status({
      tenant_id: requestContext.tenant_id,
      created_by: requestContext.subject.id,
    });
    return c.json({ data: status }, 200);
  });

  router.openapi(connectTelegramRoute, async c => {
    const requestContext = deps.resolveRequestContext(c);
    try {
      const status = await deps.telegramService.connect({
        tenant_id: requestContext.tenant_id,
        created_by: requestContext.subject.id,
        created_by_subject: createdBySubjectFromRequestContext(requestContext),
        token: c.req.valid('json').token,
      });
      return c.json({ data: status }, 201);
    } catch (error) {
      const mapped = settingsError(error);
      return c.json(mapped.body, mapped.status);
    }
  });

  router.openapi(confirmTelegramPairingRoute, async c => {
    const requestContext = deps.resolveRequestContext(c);
    const owner = { tenant_id: requestContext.tenant_id, created_by: requestContext.subject.id };
    try {
      const status = await deps.telegramService.confirmPairing({ ...owner, code: c.req.valid('json').code });
      if (status.state === 'connected') {
        // The bot says hello first, so the person sees the pairing land where they will use it.
        const connection = await deps.telegramStore.getConnection(owner);
        if (connection !== undefined && connection.paired_chat_id !== null) {
          await sendTelegramText({
            queue: deps.telegramQueue,
            client: deps.telegramService.clientFor(connection),
            chat_id: connection.paired_chat_id,
            text: 'You are paired. Send a message here and it will be answered in this chat.',
          }).catch(() => undefined);
        }
      }
      return c.json({ data: status }, 200);
    } catch (error) {
      // Confirming a pairing only ever fails with a 400: connect is the call that can be refused by Telegram.
      if (error instanceof TelegramSettingsError) {
        return c.json({ error: { message: error.message, type: error.failure } }, 400);
      }
      throw error;
    }
  });

  router.openapi(cancelTelegramPairingRoute, async c => {
    const requestContext = deps.resolveRequestContext(c);
    try {
      const status = await deps.telegramService.cancelPairing({
        tenant_id: requestContext.tenant_id,
        created_by: requestContext.subject.id,
      });
      return c.json({ data: status }, 200);
    } catch (error) {
      // Cancelling a pairing only ever fails with a 400: it makes no Telegram call to be refused.
      if (error instanceof TelegramSettingsError) {
        return c.json({ error: { message: error.message, type: error.failure } }, 400);
      }
      throw error;
    }
  });

  router.openapi(removeTelegramRoute, async c => {
    const requestContext = deps.resolveRequestContext(c);
    const status = await deps.telegramService.disconnect({
      tenant_id: requestContext.tenant_id,
      created_by: requestContext.subject.id,
    });
    return c.json({ data: status }, 200);
  });

  return router;
}

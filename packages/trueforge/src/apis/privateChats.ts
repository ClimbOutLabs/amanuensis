import { OpenAPIHono, type RouteHandler } from '@hono/zod-openapi';
import type { ISessionStore, SessionRecord } from '@truefoundry/trueforge-core/agent-session';
import { extractErrorLogFields } from '@truefoundry/trueforge-core/core';
import type { Context } from 'hono';
import type { ResolveRequestContext } from '../auth/identity';
import configuration from '../config';
import type { IAgentStore } from '../db/agentStore';
import type { IModelProviderStore } from '../db/modelProviderStore';
import type { IPersonaStore } from '../db/personaStore';
import type { SessionCustom, TurnCustom } from '../db/sessionCustom';
import { sweepPrivateChatsRoute } from '../routes/privateChatRoutes';
import { getChatPrivacyRoute } from '../routes/sessionRoutes';
import { chatPrivacy } from '../runtime/chatPrivacy';
import { checkSessionAccess, deleteChat, FORBIDDEN_SESSION_ACCESS, type DeleteChatDeps } from './sessions';

/** Expired private chats deleted per sweep; a larger backlog waits for the next pass. */
export const PRIVATE_CHAT_SWEEP_BATCH_LIMIT = 50;

export type PrivateChatSweepDeps = DeleteChatDeps;

/**
 * Deletes private chats whose expiry has passed, then turn files that belong to no chat. Runs at
 * boot and on the controller loop. One chat that fails to delete does not stop the others.
 */
export async function sweepExpiredPrivateChats(deps: PrivateChatSweepDeps, input: { now: Date }): Promise<number> {
  const expired = await deps.sessionStore.listExpiredPrivateSessions({
    now: input.now,
    limit: PRIVATE_CHAT_SWEEP_BATCH_LIMIT,
  });
  let deleted = 0;
  for (const chat of expired) {
    try {
      if (await deleteChat(deps, { ...chat, expired_by: input.now })) {
        deleted += 1;
      }
    } catch (error) {
      deps.logger.error('Could not delete an expired private chat', {
        session_id: chat.session_id,
        ...extractErrorLogFields(error),
      });
    }
  }
  await deps.chatDeletionStore.deleteOrphanedArtifacts();
  return deleted;
}

/** Internal sweep endpoint (mounted at /api/internal/private-chats) the controller calls each pass. */
export function createPrivateChatSweepRouter(deps: PrivateChatSweepDeps) {
  const handler: RouteHandler<typeof sweepPrivateChatsRoute> = async c => {
    const deleted = await sweepExpiredPrivateChats(deps, { now: new Date() });
    return c.json({ deleted }, 200);
  };
  const router = new OpenAPIHono();
  router.openapi(sweepPrivateChatsRoute, handler);
  return router;
}

export interface ChatPrivacyRouterDeps {
  sessionStore: Pick<ISessionStore<SessionCustom, TurnCustom>, 'getSession'>;
  personaStore: Pick<IPersonaStore, 'getSessionPersona' | 'getPersona'>;
  resolveAgentStore: (c: Context) => Pick<IAgentStore, 'getAgent'>;
  resolveModelProviderStore: (c: Context) => Pick<IModelProviderStore, 'getProvider'>;
  resolveRequestContext: ResolveRequestContext;
}

/** Every model a turn of this chat may call: the chat's own, its helper roles, and its persona's. */
async function chatModelNames(input: {
  record: SessionRecord;
  agentStore: Pick<IAgentStore, 'getAgent'>;
  personaStore: ChatPrivacyRouterDeps['personaStore'];
}): Promise<string[]> {
  const { record } = input;
  const spec =
    record.agent.type === 'inline'
      ? record.agent.spec
      : (await input.agentStore.getAgent({ tenant_id: record.tenant_id, id: record.agent.id }))?.manifest;
  const names = [spec?.model.name, spec?.auxiliary_models?.compaction?.name, spec?.auxiliary_models?.delegation?.name];
  const active = await input.personaStore.getSessionPersona({
    tenant_id: record.tenant_id,
    session_id: record.session_id,
  });
  if (active?.persona_id !== null && active?.persona_id !== undefined) {
    const persona = await input.personaStore.getPersona({
      tenant_id: record.tenant_id,
      created_by: record.created_by_subject.subject_id,
      id: active.persona_id,
    });
    names.push(persona?.model_name);
  }
  return names.filter(name => name !== undefined);
}

/** Where a chat is answered (mounted at /api/v1/sessions); the private chat banner reads it. */
export function createChatPrivacyRouter(deps: ChatPrivacyRouterDeps) {
  const handler: RouteHandler<typeof getChatPrivacyRoute> = async c => {
    const { session_id: sessionId } = c.req.valid('param');
    const requestContext = deps.resolveRequestContext(c);
    const record = await deps.sessionStore.getSession({ tenant_id: requestContext.tenant_id, session_id: sessionId });
    if (record === undefined) {
      return c.json({ error: { message: `Session not found: ${sessionId}` } }, 404);
    }
    if (!checkSessionAccess({ userRef: requestContext.subject.id, createdBy: record.created_by_subject.subject_id })) {
      return c.json({ error: { message: FORBIDDEN_SESSION_ACCESS } }, 403);
    }
    const privacy = await chatPrivacy({
      tenantId: requestContext.tenant_id,
      modelNames: await chatModelNames({
        record,
        agentStore: deps.resolveAgentStore(c),
        personaStore: deps.personaStore,
      }),
      tokenFactoryMayAnswer:
        configuration.TOKEN_FACTORY_MODE !== 'off' &&
        configuration.NEBIUS_API_KEY !== undefined &&
        configuration.NEBIUS_API_KEY !== '',
      modelProviderStore: deps.resolveModelProviderStore(c),
    });
    return c.json({ data: privacy }, 200);
  };
  const router = new OpenAPIHono();
  router.openapi(getChatPrivacyRoute, handler);
  return router;
}

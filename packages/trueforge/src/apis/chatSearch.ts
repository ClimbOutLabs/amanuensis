import { OpenAPIHono, type RouteHandler } from '@hono/zod-openapi';
import type { Logger } from 'winston';
import type { ResolveRequestContext } from '../auth/identity';
import type { ISentinelSettingsStore } from '../db/sentinelSettingsStore';
import { searchOwnChatsRoute } from '../routes/chatSearchRoutes';
import { readChatSearchEnabled } from '../runtime/chatSearchSettings';
import { keepOwnChatHits, type PastChatsSessionReader } from '../runtime/pastChats';
import { TENANT_ID } from './sessions';

export interface ChatSearchRouterDeps {
  sessionStore: PastChatsSessionReader;
  sentinelSettingsStore: ISentinelSettingsStore;
  resolveRequestContext: ResolveRequestContext;
  logger: Logger;
}

export function createChatSearchRouter(deps: ChatSearchRouterDeps) {
  const searchHandler: RouteHandler<typeof searchOwnChatsRoute> = async c => {
    const { query, limit } = c.req.valid('query');
    const userRef = deps.resolveRequestContext(c).subject.id;
    const enabled = await readChatSearchEnabled({
      sentinelSettingsStore: deps.sentinelSettingsStore,
      tenant_id: TENANT_ID,
      created_by: userRef,
      logger: deps.logger,
    });
    if (!enabled) {
      return c.json({ data: { search_enabled: false, hits: [] } }, 200);
    }
    // The person reads their own chat list here, every one of which they can open, so every
    // persona's chats count; the persona rule is for one assistant reading another's chats.
    const hits = await deps.sessionStore.searchChatHistory({
      tenant_id: TENANT_ID,
      query,
      created_by_subject_id: userRef,
      personas: { kind: 'all' },
      exclude_session_id: null,
      from: null,
      to: null,
      limit,
    });
    const kept = await keepOwnChatHits({ sessionStore: deps.sessionStore, tenantId: TENANT_ID, userRef, hits });
    return c.json(
      {
        data: {
          search_enabled: true,
          hits: kept.map(hit => ({
            session_id: hit.session_id,
            title: hit.title,
            snippet: hit.snippet,
            matched_at: hit.matched_at.toISOString(),
          })),
        },
      },
      200,
    );
  };

  const router = new OpenAPIHono();
  router.openapi(searchOwnChatsRoute, searchHandler);
  return router;
}

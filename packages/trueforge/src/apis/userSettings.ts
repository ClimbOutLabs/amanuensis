/**
 * User-level settings APIs (mounted at /api/v1/user).
 */
import { OpenAPIHono, type RouteHandler } from '@hono/zod-openapi';

import type { ResolveRequestContext } from '../auth/identity';
import type { ISentinelUserSettingsStore, UpdateSentinelUserSettingsInput } from '../db/sentinelUserSettingsStore';
import { getSentinelUserSettingsRoute, updateSentinelUserSettingsRoute } from '../routes/userSettingsRoutes';

export interface UserSettingsRouterDeps {
  sentinelUserSettingsStore: ISentinelUserSettingsStore;
  resolveRequestContext: ResolveRequestContext;
}

export function createUserSettingsRouter(deps: UserSettingsRouterDeps) {
  const getSentinelUserSettingsHandler: RouteHandler<typeof getSentinelUserSettingsRoute> = async c => {
    const requestContext = deps.resolveRequestContext(c);
    const settings = await deps.sentinelUserSettingsStore.get({
      tenant_id: requestContext.tenant_id,
      created_by: requestContext.subject.id,
    });
    return c.json(settings, 200);
  };

  const updateSentinelUserSettingsHandler: RouteHandler<typeof updateSentinelUserSettingsRoute> = async c => {
    const body = c.req.valid('json');
    const requestContext = deps.resolveRequestContext(c);
    const update: UpdateSentinelUserSettingsInput = {
      tenant_id: requestContext.tenant_id,
      created_by: requestContext.subject.id,
    };
    if (body.tier2_always_ask !== undefined) {
      update.tier2_always_ask = body.tier2_always_ask;
    }
    if (body.offline_mode !== undefined) {
      update.offline_mode = body.offline_mode;
    }
    const settings = await deps.sentinelUserSettingsStore.upsert(update);
    return c.json(settings, 200);
  };

  const router = new OpenAPIHono();
  router.openapi(getSentinelUserSettingsRoute, getSentinelUserSettingsHandler);
  router.openapi(updateSentinelUserSettingsRoute, updateSentinelUserSettingsHandler);
  return router;
}

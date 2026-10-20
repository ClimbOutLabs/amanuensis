import { OpenAPIHono, type RouteHandler } from '@hono/zod-openapi';
import type { ResolveRequestContext } from '../auth/identity';
import type { ISentinelSettingsStore } from '../db/sentinelSettingsStore';
import { getSentinelUserSettingsRoute, updateSentinelUserSettingsRoute } from '../routes/sentinelSettingsRoutes';
import type { UpdateSentinelUserSettingsRequest } from '../schemas/sentinelSettings';
import { TENANT_ID } from './sessions';

export interface SentinelSettingsRouterDeps {
  sentinelSettingsStore: ISentinelSettingsStore;
  resolveRequestContext: ResolveRequestContext;
}

export function createSentinelSettingsRouter(deps: SentinelSettingsRouterDeps) {
  const getHandler: RouteHandler<typeof getSentinelUserSettingsRoute> = async c => {
    const requestContext = deps.resolveRequestContext(c);
    const settings = await deps.sentinelSettingsStore.get({
      tenant_id: TENANT_ID,
      created_by: requestContext.subject.id,
    });
    return c.json({ data: settings }, 200);
  };

  const updateHandler: RouteHandler<typeof updateSentinelUserSettingsRoute> = async c => {
    const body: UpdateSentinelUserSettingsRequest = c.req.valid('json');
    const requestContext = deps.resolveRequestContext(c);
    const settings = await deps.sentinelSettingsStore.patch({
      tenant_id: TENANT_ID,
      created_by: requestContext.subject.id,
      offline_mode: body.offline_mode,
      tier2_auto_allow: body.tier2_auto_allow,
      search_without_asking: body.search_without_asking,
      maps_without_asking: body.maps_without_asking,
    });
    return c.json({ data: settings }, 200);
  };

  const router = new OpenAPIHono();
  router.openapi(getSentinelUserSettingsRoute, getHandler);
  router.openapi(updateSentinelUserSettingsRoute, updateHandler);
  return router;
}

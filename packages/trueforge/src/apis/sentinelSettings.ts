import { OpenAPIHono, type RouteHandler } from '@hono/zod-openapi';
import type { ResolveRequestContext } from '../auth/identity';
import type { ISentinelSettingsStore } from '../db/sentinelSettingsStore';
import { getSentinelUserSettingsRoute, updateSentinelUserSettingsRoute } from '../routes/sentinelSettingsRoutes';
import { packageMirrorTokens } from '../sandbox/mirrors/packageMirrorTokens';
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
    const owner = { tenant_id: TENANT_ID, created_by: requestContext.subject.id };
    const settings = await deps.sentinelSettingsStore.patch({
      ...owner,
      offline_mode: body.offline_mode,
      tier2_auto_allow: body.tier2_auto_allow,
      search_without_asking: body.search_without_asking,
      maps_without_asking: body.maps_without_asking,
      sandbox_without_asking: body.sandbox_without_asking,
      chat_search_enabled: body.chat_search_enabled,
      package_downloads_without_project_allowed: body.package_downloads_without_project_allowed,
    });
    if (body.package_downloads_without_project_allowed === false) {
      // Taking the allowance back ends every live mirror grant for the person's chats without a
      // project at once, in this same request.
      packageMirrorTokens.revokePersonWithoutRepository(owner);
    }
    return c.json({ data: settings }, 200);
  };

  const router = new OpenAPIHono();
  router.openapi(getSentinelUserSettingsRoute, getHandler);
  router.openapi(updateSentinelUserSettingsRoute, updateHandler);
  return router;
}

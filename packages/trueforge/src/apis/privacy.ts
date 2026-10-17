import { OpenAPIHono, type RouteHandler } from '@hono/zod-openapi';

import type { ResolveRequestContext } from '../auth/identity';
import type { IOutboundEventStore } from '../db/outboundEventStore';
import { listDataLocationsRoute, listOutboundEventsRoute } from '../routes/privacyRoutes';
import { listDataLocations, type DataLocationsInput } from '../runtime/dataLocations';

/** How far back the owner's list of outgoing requests reaches. */
export const OUTBOUND_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface OutboundEventsRouterDeps {
  outboundEventStore: IOutboundEventStore;
  resolveRequestContext: ResolveRequestContext;
  now?: (() => Date) | undefined;
}

/** Admin route (mounted at /api/v1/settings/outbound-events). */
export function createOutboundEventsRouter(deps: OutboundEventsRouterDeps) {
  const handler: RouteHandler<typeof listOutboundEventsRoute> = async c => {
    const { limit } = c.req.valid('query');
    const requestContext = deps.resolveRequestContext(c);
    const windowStart = new Date((deps.now?.() ?? new Date()).getTime() - OUTBOUND_WINDOW_MS);
    // One extra row tells whether the window holds more than the page returned.
    const rows = await deps.outboundEventStore.listSince({
      tenant_id: requestContext.tenant_id,
      since: windowStart,
      limit: limit + 1,
    });
    return c.json(
      { data: rows.slice(0, limit), window_start: windowStart.toISOString(), truncated: rows.length > limit },
      200,
    );
  };
  const router = new OpenAPIHono();
  router.openapi(listOutboundEventsRoute, handler);
  return router;
}

export interface DataLocationsRouterDeps {
  /** Read per request so the answer follows the running configuration. */
  locations: () => DataLocationsInput;
}

/** Admin route (mounted at /api/v1/settings/data-locations). */
export function createDataLocationsRouter(deps: DataLocationsRouterDeps) {
  const handler: RouteHandler<typeof listDataLocationsRoute> = async c =>
    c.json({ data: await listDataLocations(deps.locations()) }, 200);
  const router = new OpenAPIHono();
  router.openapi(listDataLocationsRoute, handler);
  return router;
}

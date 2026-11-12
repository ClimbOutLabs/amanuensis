import { OpenAPIHono, type RouteHandler } from '@hono/zod-openapi';

import { runNoticingRoute } from '../routes/reachRoutes';
import type { NoticingService } from '../runtime/noticing/noticingService';

export interface NoticingRouterDeps {
  noticing: NoticingService;
}

/** The controller's way in, mounted at /api/internal/noticing and open only to the service credential. */
export function createNoticingRouter(deps: NoticingRouterDeps) {
  const runHandler: RouteHandler<typeof runNoticingRoute> = async c => {
    const { watcher } = c.req.valid('json');
    return c.json({ data: await deps.noticing.run({ watcher }) }, 200);
  };
  const router = new OpenAPIHono();
  router.openapi(runNoticingRoute, runHandler);
  return router;
}

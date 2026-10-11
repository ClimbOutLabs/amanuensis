import { OpenAPIHono } from '@hono/zod-openapi';
import { runCodeStatusFromReadiness, type DriverReadiness } from '@truefoundry/trueforge-core/core';
import { getRunCodeStatusRoute } from '../routes/runCodeRoutes';

export interface RunCodeRouterDeps {
  /** False while no sandbox image is pinned: run_code is dormant and Docker is never probed. */
  imageConfigured: () => boolean;
  ensureReady: (signal: AbortSignal) => Promise<DriverReadiness>;
}

/** Admin/settings run_code surface (mounted at /api/v1/settings/run-code). */
export function createRunCodeRouter(deps: RunCodeRouterDeps) {
  const router = new OpenAPIHono();
  router.openapi(getRunCodeStatusRoute, async c => {
    if (!deps.imageConfigured()) {
      return c.json({ data: { state: 'not_configured' as const } }, 200);
    }
    const readiness = await deps.ensureReady(c.req.raw.signal);
    return c.json({ data: runCodeStatusFromReadiness(readiness) }, 200);
  });
  return router;
}

import { OpenAPIHono } from '@hono/zod-openapi';
import { runCodeStatusFromReadiness, type DriverReadiness } from '@truefoundry/trueforge-core/core';
import { getRunCodeStatusRoute } from '../routes/runCodeRoutes';

export interface RunCodeRouterDeps {
  /** Undefined while the sandbox slots are off: run_code is not configured. */
  ensureReady: (signal: AbortSignal) => Promise<DriverReadiness> | undefined;
}

/** Admin/settings run_code surface (mounted at /api/v1/settings/run-code). */
export function createRunCodeRouter(deps: RunCodeRouterDeps) {
  const router = new OpenAPIHono();
  router.openapi(getRunCodeStatusRoute, async c => {
    const readiness = await deps.ensureReady(c.req.raw.signal);
    if (readiness === undefined) {
      return c.json({ data: { state: 'not_configured' as const } }, 200);
    }
    return c.json({ data: runCodeStatusFromReadiness(readiness) }, 200);
  });
  return router;
}

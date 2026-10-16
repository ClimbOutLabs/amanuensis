import { OpenAPIHono } from '@hono/zod-openapi';
import { runCodeStatusFromReadiness, type DriverReadiness } from '@truefoundry/trueforge-core/core';
import { getRunCodeStatusRoute } from '../routes/runCodeRoutes';

export interface RunCodeRouterDeps {
  /** Which backend answers, so the status page can word itself for it. */
  backend: () => 'docker' | 'slots';
  /** The installer instance's name, or undefined when the server was not set up by the installer. */
  installerInstance: () => string | undefined;
  /** False while no sandbox image is pinned: run_code is dormant and Docker is never probed. */
  imageConfigured: () => boolean;
  ensureReady: (signal: AbortSignal) => Promise<DriverReadiness>;
}

/** Admin/settings run_code surface (mounted at /api/v1/settings/run-code). */
export function createRunCodeRouter(deps: RunCodeRouterDeps) {
  const router = new OpenAPIHono();
  router.openapi(getRunCodeStatusRoute, async c => {
    if (!deps.imageConfigured()) {
      const instance = deps.installerInstance();
      if (instance !== undefined) {
        // An installer instance without a sandbox is off by choice, not misconfigured.
        return c.json({ data: { state: 'disabled' as const, backend: 'slots' as const, instance } }, 200);
      }
      return c.json({ data: { state: 'not_configured' as const, backend: deps.backend() } }, 200);
    }
    const readiness = await deps.ensureReady(c.req.raw.signal);
    return c.json({ data: { ...runCodeStatusFromReadiness(readiness), backend: deps.backend() } }, 200);
  });
  return router;
}

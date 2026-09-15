/**
 * App-level bug-report bundle endpoint (mounted at `/api/v1/bug-reports`).
 * Session-less by design: build identity, the reporter's description, and non-secret config
 * flags, all assembled locally — no session lookup, no event reads, nothing session-bound.
 */
import { OpenAPIHono, type RouteHandler } from '@hono/zod-openapi';
import type { Logger } from 'winston';
import type { ResolveRequestContext } from '../auth/identity';
import { hasAdminRole } from '../auth/identity';
import configuration from '../config';
import type { IMcpServerStore } from '../db/mcpServerStore';
import type { ISandboxProviderStore } from '../db/sandboxProviderStore';
import { PACKAGE_VERSION } from '../packageVersion';
import { createAppBugReportRoute, getBugReportHandoffRoute } from '../routes/bugReportRoutes';
import { buildAppBugReportBundle } from './bugReportRedactor';
import { readLocalCapabilitiesData, toBuildIdentity } from './capabilities';

export interface AppBugReportRouterDeps<TTransaction> {
  sandboxProviderStore: ISandboxProviderStore<TTransaction>;
  mcpServerStore: IMcpServerStore<TTransaction>;
  resolveRequestContext: ResolveRequestContext;
  logger: Logger;
}

/** App-level bug-report bundle router (mounted at `/api/v1/bug-reports`). */
export function createAppBugReportRouter<TTransaction>(deps: AppBugReportRouterDeps<TTransaction>) {
  const createAppBugReportHandler: RouteHandler<typeof createAppBugReportRoute> = async c => {
    const body = c.req.valid('json');
    const requestContext = deps.resolveRequestContext(c);

    // config_flags are sourced from the persisted sandbox status only: generating a bug report
    // must stay local and read-only, never dialing the sandbox provider or mutating its state.
    // readLocalCapabilitiesData performs no outbound I/O.
    const capabilities = await readLocalCapabilitiesData({
      sandboxProviderStore: deps.sandboxProviderStore,
      mcpServerStore: deps.mcpServerStore,
      logger: deps.logger,
      isAdmin: hasAdminRole(requestContext),
    });

    const bundle = buildAppBugReportBundle({
      build: toBuildIdentity({ version: PACKAGE_VERSION, buildRef: configuration.BUILD_REF }),
      description: body.description,
      configFlags: {
        sandbox_enabled: capabilities.sandbox.enabled,
        skill_enabled: capabilities.skill.enabled,
        settings_enabled: capabilities.settings.enabled,
      },
    });

    return c.json({ data: bundle }, 200);
  };

  // Reads nothing from the request: the handoff target is a static, host-configured URL (or null
  // when the host disabled it), so this handler is a pure config lookup.
  const getBugReportHandoffHandler: RouteHandler<typeof getBugReportHandoffRoute> = c => {
    return c.json({ data: { issue_url: configuration.BUG_REPORT_HANDOFF_URL } }, 200);
  };

  const router = new OpenAPIHono();
  router.openapi(createAppBugReportRoute, createAppBugReportHandler);
  router.openapi(getBugReportHandoffRoute, getBugReportHandoffHandler);
  return router;
}

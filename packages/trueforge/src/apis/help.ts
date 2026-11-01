import { OpenAPIHono, type RouteHandler } from '@hono/zod-openapi';
import { extractErrorLogFields } from '@truefoundry/trueforge-core/core';
import type { Context } from 'hono';
import type { Logger } from 'winston';

import { hasAdminRole, type ResolveRequestContext } from '../auth/identity';
import configuration from '../config';
import type { IGlobalSettingsStore } from '../db/globalSettingsStore';
import type { IGoogleConnectionStore } from '../db/googleConnectionStore';
import type { IMcpServerStore } from '../db/mcpServerStore';
import type { IModelProviderStore } from '../db/modelProviderStore';
import type { ISandboxProviderStore } from '../db/sandboxProviderStore';
import { buildHelpHealthCheck, type SchedulerProbe } from '../help/healthCheck';
import { probeConnectors, probeGoogleLogin, probeModel } from '../help/healthProbes';
import { readHostReport } from '../help/hostReport';
import type { IOAuthTokenStore } from '../mcp/auth/types';
import { getHelpHealthCheckRoute } from '../routes/helpRoutes';
import { computeCapabilitiesData } from './capabilities';

export interface HelpRouterDeps {
  resolveRequestContext: ResolveRequestContext;
  resolveModelProviderStore: (c: Context) => IModelProviderStore;
  resolveMcpServerStore: (c: Context) => IMcpServerStore;
  resolveSandboxProviderStore: (c: Context) => ISandboxProviderStore;
  tokenStore: IOAuthTokenStore;
  globalSettingsStore: IGlobalSettingsStore;
  googleConnectionStore: IGoogleConnectionStore;
  /** Where the installer writes its latest full check. Read only. */
  hostReportPath: string;
  /** Whether the schedule loop runs in this process, and if so whether it is running. */
  schedulerStatus: () => SchedulerProbe;
  logger: Logger;
}

/** Help health check (mounted at /api/v1/help). Each probe reuses the owner of the feature it checks. */
export function createHelpRouter(deps: HelpRouterDeps) {
  const router = new OpenAPIHono();

  const healthCheckHandler: RouteHandler<typeof getHelpHealthCheckRoute> = async c => {
    const requestContext = deps.resolveRequestContext(c);
    const tenantId = requestContext.tenant_id;
    const now = new Date();
    const mcpServerStore = deps.resolveMcpServerStore(c);
    const [model, connectors, google, sandboxReady, hostReport] = await Promise.all([
      probeModel({
        tenantId,
        modelProviderStore: deps.resolveModelProviderStore(c),
        globalSettingsStore: deps.globalSettingsStore,
        logger: deps.logger,
      }),
      probeConnectors({
        tenantId,
        userRef: requestContext.subject.id,
        mcpServerStore,
        tokenStore: deps.tokenStore,
        clientName: configuration.MCP_DCR_OAUTH_CLIENT_NAME,
        requestTimeoutMs: configuration.MCP_REQUEST_TIMEOUT_MS,
        connectTimeoutMs: configuration.MCP_CONNECT_TIMEOUT_MS,
        logger: deps.logger,
      }),
      probeGoogleLogin({
        owner: { tenant_id: tenantId, created_by: requestContext.subject.id },
        connections: deps.googleConnectionStore,
        fetchImpl: undefined,
        logger: deps.logger,
      }),
      computeCapabilitiesData({
        sandboxProviderStore: deps.resolveSandboxProviderStore(c),
        mcpServerStore,
        globalSettingsStore: deps.globalSettingsStore,
        logger: deps.logger,
        tenantId,
        isAdmin: hasAdminRole(requestContext),
      }).then(
        data => data.sandbox.enabled,
        (error: unknown) => {
          deps.logger.warn('Help check: the sandbox status could not be read', extractErrorLogFields(error));
          return false;
        },
      ),
      readHostReport({ path: deps.hostReportPath, now }),
    ]);
    const data = buildHelpHealthCheck({
      results: {
        model,
        connectors,
        google,
        sandboxReady,
        scheduler: deps.schedulerStatus(),
        hostReport,
      },
      now,
    });
    return c.json({ data }, 200);
  };

  router.openapi(getHelpHealthCheckRoute, healthCheckHandler);
  return router;
}

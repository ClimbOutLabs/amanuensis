import { OpenAPIHono, type RouteHandler } from '@hono/zod-openapi';
import { InvalidPageTokenError } from '@truefoundry/trueforge-core/agent-session';

import type { ResolveRequestContext } from '../auth/identity';
import type { ISentinelAuditStore } from '../db/sentinelAuditStore';
import { listUserAuditLogRoute } from '../routes/auditLogRoutes';

export interface AuditLogRouterDeps {
  sentinelAuditStore: ISentinelAuditStore;
  resolveRequestContext: ResolveRequestContext;
}

/** Per-user audit log across chats, mounted at /api/v1/user/audit-log. */
export function createAuditLogRouter(deps: AuditLogRouterDeps) {
  const handler: RouteHandler<typeof listUserAuditLogRoute> = async c => {
    const query = c.req.valid('query');
    const requestContext = deps.resolveRequestContext(c);
    try {
      const page = await deps.sentinelAuditStore.listForUser({
        tenant_id: requestContext.tenant_id,
        created_by: requestContext.subject.id,
        outcome: query.outcome,
        limit: query.limit,
        page_token: query.page_token,
      });
      return c.json(
        {
          data: page.entries,
          pagination: {
            limit: query.limit,
            ...(page.next_page_token === undefined ? {} : { next_page_token: page.next_page_token }),
          },
        },
        200,
      );
    } catch (error) {
      if (error instanceof InvalidPageTokenError) {
        return c.json({ error: { message: error.message } }, 400);
      }
      throw error;
    }
  };

  const router = new OpenAPIHono();
  router.openapi(listUserAuditLogRoute, handler);
  return router;
}

import { OpenAPIHono, type RouteHandler } from '@hono/zod-openapi';
import type { ISessionStore } from '@truefoundry/trueforge-core/agent-session';

import type { ResolveRequestContext } from '../auth/identity';
import type { SessionCustom, TurnCustom } from '../db/sessionCustom';
import { createRecallExclusionRoute } from '../routes/recallExclusionRoutes';
import { excludeRecallFact } from '../runtime/memory/recallExclusions';
import { checkSessionAccess } from './sessions';

export interface RecallExclusionsRouterDeps {
  sessionStore: Pick<ISessionStore<SessionCustom, TurnCustom>, 'getSession'>;
  resolveRequestContext: ResolveRequestContext;
}

/**
 * Pulling a fact out of one chat's recall (mounted at /api/v1/sessions). The exclusion is
 * recorded for this chat only; the recall path honours it from the next turn on, and the
 * memory itself is never touched.
 */
export function createRecallExclusionsRouter(deps: RecallExclusionsRouterDeps) {
  const router = new OpenAPIHono();

  const createHandler: RouteHandler<typeof createRecallExclusionRoute> = async c => {
    const { session_id: sessionId } = c.req.valid('param');
    const body = c.req.valid('json');
    const requestContext = deps.resolveRequestContext(c);
    const session = await deps.sessionStore.getSession({ tenant_id: requestContext.tenant_id, session_id: sessionId });
    if (session === undefined) {
      return c.json({ error: { message: `Session not found: ${sessionId}` } }, 404);
    }
    if (
      !checkSessionAccess({
        userRef: requestContext.subject.id,
        createdBy: session.created_by_subject.subject_id,
      })
    ) {
      return c.json({ error: { message: 'Caller is not the session creator.' } }, 403);
    }
    excludeRecallFact({ sessionId, factText: body.fact_text });
    return c.json({ data: { session_id: sessionId, fact_text: body.fact_text } }, 201);
  };

  router.openapi(createRecallExclusionRoute, createHandler);
  return router;
}

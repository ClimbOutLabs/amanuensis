import { OpenAPIHono, type RouteHandler } from '@hono/zod-openapi';
import type { ISessionStore } from '@truefoundry/trueforge-core/agent-session';
import type { AuditLogWriter } from '@truefoundry/trueforge-core/core';
import type { ResolveRequestContext } from '../auth/identity';
import { BRIEF_ITEM_DONE_WINDOW_MS, type IBriefItemCompletionStore } from '../db/briefItemCompletionStore';
import type { SessionCustom, TurnCustom } from '../db/sessionCustom';
import {
  listBriefItemCompletionsRoute,
  markBriefItemDoneRoute,
  undoBriefItemDoneRoute,
} from '../routes/briefItemRoutes';
import { checkSessionAccess } from './sessions';

export interface BriefItemsRouterDeps {
  briefItemStore: IBriefItemCompletionStore;
  audit: AuditLogWriter;
  sessionStore: Pick<ISessionStore<SessionCustom, TurnCustom>, 'getSession'>;
  resolveRequestContext: ResolveRequestContext;
}

/**
 * Morning brief items marked done, mounted at /api/v1/user/brief-items. Each change is written to the
 * Sentinel audit log under the caller.
 */
export function createBriefItemsRouter(deps: BriefItemsRouterDeps) {
  const markDoneHandler: RouteHandler<typeof markBriefItemDoneRoute> = async c => {
    const body = c.req.valid('json');
    const requestContext = deps.resolveRequestContext(c);
    const owner = { tenant_id: requestContext.tenant_id, created_by: requestContext.subject.id };
    const session = await deps.sessionStore.getSession({ tenant_id: owner.tenant_id, session_id: body.session_id });
    // Another person's chat reads as missing, so its existence is not revealed.
    if (
      session === undefined ||
      !checkSessionAccess({ userRef: owner.created_by, createdBy: session.created_by_subject.subject_id })
    ) {
      return c.json({ error: { message: `Session not found: ${body.session_id}` } }, 404);
    }
    const completion = await deps.briefItemStore.markDone({
      ...owner,
      item_key: body.item_key,
      section: body.section,
      title: body.title,
    });
    await deps.audit.record({
      ...owner,
      conversation_id: body.session_id,
      tier: 1,
      tool_name: 'brief.item_done',
      description: `Marked brief item done: ${body.title}`,
      outcome: 'logged',
      auto_deny_reason: null,
    });
    return c.json(completion, 200);
  };

  const undoHandler: RouteHandler<typeof undoBriefItemDoneRoute> = async c => {
    const { item_key: itemKey } = c.req.valid('param');
    const requestContext = deps.resolveRequestContext(c);
    const owner = { tenant_id: requestContext.tenant_id, created_by: requestContext.subject.id };
    const removed = await deps.briefItemStore.undo({ ...owner, item_key: itemKey });
    // Only a real removal is audited; repeating an undo changes nothing to record.
    if (removed !== undefined) {
      await deps.audit.record({
        ...owner,
        conversation_id: '',
        tier: 1,
        tool_name: 'brief.item_undone',
        description: `Undid brief item done: ${removed.title}`,
        outcome: 'logged',
        auto_deny_reason: null,
      });
    }
    return c.body(null, 204);
  };

  const listHandler: RouteHandler<typeof listBriefItemCompletionsRoute> = async c => {
    const query = c.req.valid('query');
    const requestContext = deps.resolveRequestContext(c);
    const since = query.since === undefined ? new Date(Date.now() - BRIEF_ITEM_DONE_WINDOW_MS) : new Date(query.since);
    const data = await deps.briefItemStore.listCompletedSince({
      tenant_id: requestContext.tenant_id,
      created_by: requestContext.subject.id,
      since,
    });
    return c.json({ data }, 200);
  };

  const router = new OpenAPIHono();
  router.openapi(markBriefItemDoneRoute, markDoneHandler);
  router.openapi(undoBriefItemDoneRoute, undoHandler);
  router.openapi(listBriefItemCompletionsRoute, listHandler);
  return router;
}

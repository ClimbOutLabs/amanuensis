/**
 * Redacted bug-report bundle endpoint (mounted at `/api/v1/sessions`, alongside — not inside —
 * `createSessionsRouter`, so this module can depend on `./sessions` and `./capabilities` for
 * `TENANT_ID` / access checks / capability flags without either of those importing back here).
 */
import { OpenAPIHono, type RouteHandler } from '@hono/zod-openapi';
import type { AgentSpec, SessionAgent, SessionHandle, Sessions } from '@truefoundry/trueforge-core/agent-session';
import type { Logger } from 'winston';
import { hasAdminRole, type ResolveRequestContext } from '../auth/identity';
import configuration from '../config';
import type { IAgentStore } from '../db/agentStore';
import type { IMcpServerStore } from '../db/mcpServerStore';
import type { ISandboxProviderStore } from '../db/sandboxProviderStore';
import type { SessionCustom, TurnCustom } from '../db/sessionCustom';
import { PACKAGE_VERSION } from '../packageVersion';
import { createSessionBugReportRoute } from '../routes/sessionRoutes';
import { EVENTS_PAGE_LIMIT } from '../schemas/common';
import { buildBugReportBundle } from './bugReportRedactor';
import { readLocalCapabilitiesData, toBuildIdentity } from './capabilities';
import { checkSessionAccess, FORBIDDEN_SESSION_ACCESS, TENANT_ID } from './sessions';

/** Hard cap on how many events (across pages) feed one bundle, bounding both bundle size and request time. */
const BUG_REPORT_MAX_EVENT_PAGES = 5;

export interface BugReportRouterDeps<TTransaction> {
  sessions: Sessions<SessionCustom, TurnCustom>;
  sandboxProviderStore: ISandboxProviderStore<TTransaction>;
  mcpServerStore: IMcpServerStore<TTransaction>;
  agentStore: IAgentStore<TTransaction>;
  resolveRequestContext: ResolveRequestContext;
  logger: Logger;
}

/** Recent events for a session, newest first, capped at `BUG_REPORT_MAX_EVENT_PAGES` pages. */
async function fetchRecentEvents(
  session: Pick<SessionHandle<SessionCustom, TurnCustom>, 'listEvents'>,
): Promise<{ turn_id: string; event: unknown }[]> {
  const collected: { turn_id: string; event: unknown }[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < BUG_REPORT_MAX_EVENT_PAGES; page += 1) {
    const { data, pagination } = await session.listEvents({ limit: EVENTS_PAGE_LIMIT, page_token: pageToken });
    collected.push(...data);
    if (pagination.next_page_token === undefined) {
      break;
    }
    pageToken = pagination.next_page_token;
  }
  return collected;
}

/** Which configured pieces the agent has attached, by name only: enough to reproduce, nothing that configures them. */
function agentAttachments(spec: AgentSpec | undefined): {
  connectors: string[];
  skills: string[];
  sandboxEnabled: boolean;
} {
  return {
    connectors: (spec?.mcp_servers ?? []).map(server => server.name),
    skills: (spec?.skills ?? []).map(skill => skill.name),
    sandboxEnabled: spec?.config.sandbox.enabled ?? false,
  };
}

/** Registry agent name (or null for inline), the model FQN in effect, and the attachments, without echoing the rest of the spec. */
async function resolveAgentIdentity<TTransaction>(input: {
  agent: SessionAgent;
  agentStore: IAgentStore<TTransaction>;
}): Promise<{ agentName: string | null; model: string | null } & ReturnType<typeof agentAttachments>> {
  if (input.agent.type === 'inline') {
    return { agentName: null, model: input.agent.spec.model.name, ...agentAttachments(input.agent.spec) };
  }
  const record = await input.agentStore.getAgent({ tenant_id: TENANT_ID, id: input.agent.id });
  return {
    agentName: input.agent.name,
    model: record ? record.manifest.model.name : null,
    ...agentAttachments(record?.manifest),
  };
}

/** Bug-report bundle router (mounted at `/api/v1/sessions`). */
export function createBugReportRouter<TTransaction>(deps: BugReportRouterDeps<TTransaction>) {
  const createBugReportHandler: RouteHandler<typeof createSessionBugReportRoute> = async c => {
    const { session_id: sessionId } = c.req.valid('param');
    const body = c.req.valid('json');
    const session = await deps.sessions.get({ tenant_id: TENANT_ID, session_id: sessionId });
    if (!session) {
      return c.json({ error: { message: `Session not found: ${sessionId}` } }, 404);
    }
    const requestContext = deps.resolveRequestContext(c);
    if (
      !checkSessionAccess({
        userRef: requestContext.subject.id,
        createdBy: session.record.created_by_subject.subject_id,
      })
    ) {
      return c.json({ error: { message: FORBIDDEN_SESSION_ACCESS } }, 403);
    }

    // config_flags are sourced from the persisted sandbox status only: generating a bug report
    // must stay local and read-only, never dialing the sandbox provider or mutating its state.
    // readLocalCapabilitiesData performs no outbound I/O.
    const [{ agentName, model, connectors, skills, sandboxEnabled }, events, capabilities] = await Promise.all([
      resolveAgentIdentity({ agent: session.record.agent, agentStore: deps.agentStore }),
      fetchRecentEvents(session),
      readLocalCapabilitiesData({
        sandboxProviderStore: deps.sandboxProviderStore,
        mcpServerStore: deps.mcpServerStore,
        logger: deps.logger,
        isAdmin: hasAdminRole(requestContext),
      }),
    ]);

    const bundle = buildBugReportBundle({
      build: toBuildIdentity({ version: PACKAGE_VERSION, buildRef: configuration.BUILD_REF }),
      session: {
        id: session.record.session_id,
        agentName,
        model,
        createdAt: session.record.created_at.toISOString(),
        connectors,
        skills,
        sandboxEnabled,
      },
      description: body.description,
      includeChat: body.include_chat === true,
      events,
      configFlags: {
        sandbox_enabled: capabilities.sandbox.enabled,
        skill_enabled: capabilities.skill.enabled,
        settings_enabled: capabilities.settings.enabled,
      },
    });

    return c.json({ data: bundle }, 200);
  };

  const router = new OpenAPIHono();
  router.openapi(createSessionBugReportRoute, createBugReportHandler);
  return router;
}

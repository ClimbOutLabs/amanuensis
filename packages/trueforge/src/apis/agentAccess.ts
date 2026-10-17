/**
 * Agent store reads narrowed by the authorizer, shared by the agent, session,
 * and schedule handlers. Lives in the API layer because stores must stay free
 * of request identity.
 */
import type { TokenPagination } from '@truefoundry/trueforge-core/agent-session';
import type { AgentAction, Authorizer } from '../auth/authorizer';
import type { RequestContext } from '../auth/identity';
import type { AgentRecord, IAgentStore } from '../db/agentStore';

/** The agent only when the caller may act on it, so callers answer 404 for missing and forbidden alike. */
export async function agentIfAccessible(input: {
  authorizer: Authorizer;
  context: RequestContext;
  action: AgentAction;
  agent: AgentRecord | undefined;
}): Promise<AgentRecord | undefined> {
  if (input.agent === undefined) {
    return undefined;
  }
  const allowed = await input.authorizer.canAccessAgent({
    context: input.context,
    action: input.action,
    agent: input.agent,
  });
  return allowed ? input.agent : undefined;
}

/** Resolve the authorizer list scope against the agent store without extra store filters. */
export async function listAccessibleAgents<TTransaction>(input: {
  store: IAgentStore<TTransaction>;
  context: RequestContext;
  authorizer: Authorizer;
  action: AgentAction;
  agent_name: string | undefined;
  limit: number | undefined;
  page_token: string | undefined;
}): Promise<{ data: AgentRecord[]; pagination: TokenPagination }> {
  const access = await input.authorizer.listAgentAccess({ context: input.context, action: input.action });
  if (access.kind === 'all') {
    return input.store.listAgents({
      tenant_id: input.context.tenant_id,
      agent_name: input.agent_name,
      limit: input.limit,
      page_token: input.page_token,
    });
  }
  return input.store.listAgents({
    tenant_id: input.context.tenant_id,
    external_ids: access.agent_external_ids,
    agent_name: input.agent_name,
    limit: input.limit,
    page_token: input.page_token,
  });
}

/**
 * Resolve only explicit manage grants to internal ids. An `all` scope does not
 * identify explicit grants and must not widen related-resource visibility.
 */
export async function resolveManagedAgentIds<TTransaction>(input: {
  store: IAgentStore<TTransaction>;
  context: RequestContext;
  authorizer: Authorizer;
}): Promise<string[]> {
  const { store, context, authorizer } = input;
  const access = await authorizer.listAgentAccess({ context, action: 'manage' });
  if (access.kind === 'all') {
    return [];
  }
  const { data } = await store.listAgents({
    tenant_id: context.tenant_id,
    external_ids: access.agent_external_ids,
    agent_name: undefined,
    limit: undefined,
    page_token: undefined,
  });
  return data.map(agent => agent.id);
}

/**
 * Every agent the caller may manage. Unlike `resolveManagedAgentIds`, an `all` list scope is
 * resolved per agent (standalone and OIDC allow managing only agents the caller created), so the
 * result is the caller's agents on those instances too.
 */
export async function listManageableAgents<TTransaction>(input: {
  store: IAgentStore<TTransaction>;
  context: RequestContext;
  authorizer: Authorizer;
}): Promise<AgentRecord[]> {
  const { store, context, authorizer } = input;
  const access = await authorizer.listAgentAccess({ context, action: 'manage' });
  const agents: AgentRecord[] = [];
  let pageToken: string | undefined;
  for (;;) {
    const page = await store.listAgents({
      tenant_id: context.tenant_id,
      ...(access.kind === 'agent_external_ids' ? { external_ids: access.agent_external_ids } : {}),
      agent_name: undefined,
      limit: 200,
      page_token: pageToken,
    });
    for (const agent of page.data) {
      if (await authorizer.canAccessAgent({ context, action: 'manage', agent })) {
        agents.push(agent);
      }
    }
    if (page.pagination.next_page_token === undefined) {
      return agents;
    }
    pageToken = page.pagination.next_page_token;
  }
}

/** Related rows are readable by their creator or a manager of the bound named agent. */
export async function canReadAgentBoundResource<TTransaction>(input: {
  store: IAgentStore<TTransaction>;
  context: RequestContext;
  authorizer: Authorizer;
  created_by_subject_id: string;
  agent_id: string | undefined;
}): Promise<boolean> {
  const { store, context, authorizer, created_by_subject_id, agent_id } = input;
  if (created_by_subject_id === context.subject.id) {
    return true;
  }
  if (agent_id === undefined) {
    return false;
  }
  const managedAgentIds = await resolveManagedAgentIds({ store, context, authorizer });
  return managedAgentIds.includes(agent_id);
}

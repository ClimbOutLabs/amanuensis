import { actionIdFor, approvalTokenExpiry, type ApprovalTokenScope, type ConnectorBinding } from './approvalTokens';
import { autoDenyDecision, type TierDecision } from './tier';
import type { ClassifyContext, SentinelAction } from './tierTypes';

/** Scope and expiry every approval token is minted with; dispatch redeems under the same identity. */
export function approvalTokenOwner(ctx: ClassifyContext): ApprovalTokenScope & { expires_at: string } {
  return { tenant_id: ctx.tenant_id, created_by: ctx.created_by, expires_at: approvalTokenExpiry() };
}

export async function mintPlainToken(input: {
  ctx: ClassifyContext;
  tool_name: string;
  params: unknown;
  connector?: ConnectorBinding | undefined;
}): Promise<string> {
  const token = await input.ctx.services.token_store.mint({
    ...approvalTokenOwner(input.ctx),
    action_id: actionIdFor({
      tool_name: input.tool_name,
      canonical_params: input.params,
      connector: input.connector,
    }),
    canonical_params: input.params,
  });
  return token.token_id;
}

/** A held call that is skipped rather than asked, for a scheduled run with nobody to answer. */
export function steeredSkipped(ctx: ClassifyContext): TierDecision {
  const assistant = ctx.web_search.assistantName;
  return autoDenyDecision({
    reason: 'steered_by_content',
    reason_detail: `A link or address in something ${assistant} read chose this, not you.`,
    owner_message: `One step was skipped, because something ${assistant} read asked for it, not you.`,
    sensitive_read: false,
  });
}

export function demoRefusal(reason_detail: string): TierDecision {
  return autoDenyDecision({ reason: 'outbound_guard', reason_detail, sensitive_read: false });
}

/** Whether an "Always allow" grant covers this call's tool, looked up as a connector call's grant is. */
export function hasStandingToolGrant(ctx: ClassifyContext, action: SentinelAction): Promise<boolean> {
  if (action.mcp_server_name === undefined) {
    return Promise.resolve(false);
  }
  return ctx.services.tool_grants.hasToolGrant({
    tenant_id: ctx.tenant_id,
    created_by: ctx.created_by,
    mcp_server_name: action.mcp_server_name,
    tool_name: action.tool_name,
    connector_binding: action.mcp_grant_binding ?? null,
  });
}

/** Whether a standing grant is stored under a scope key instead of the tool's own name (a Home Assistant domain). */
export function hasStandingScopeGrant(
  ctx: ClassifyContext,
  action: SentinelAction,
  scope_key: string,
): Promise<boolean> {
  if (action.mcp_server_name === undefined) {
    return Promise.resolve(false);
  }
  return ctx.services.tool_grants.hasToolGrant({
    tenant_id: ctx.tenant_id,
    created_by: ctx.created_by,
    mcp_server_name: action.mcp_server_name,
    tool_name: scope_key,
    connector_binding: action.mcp_grant_binding ?? null,
  });
}

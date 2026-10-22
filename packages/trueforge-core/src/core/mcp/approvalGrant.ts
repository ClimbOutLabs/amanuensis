import type { ApprovalDecision } from '../events/schema';
import type { InternalEnrichedToolCall, InternalToolCallInfo } from '../llm/LLMTypes';
import {
  SANDBOX_APPLY_PATCH_TOOL_NAME,
  SANDBOX_MCP_SERVER_ID,
  SANDBOX_REPLACE_TEXT_TOOL_NAME,
  SANDBOX_RUN_REGISTERED_COMMAND_TOOL_NAME,
  SANDBOX_WRITE_FILE_TOOL_NAME,
} from '../sandbox/Sandbox';
import { GRANT_BARRED_TIER_REASONS } from '../permissions/tier';
import { SEARCH_AFTER_PRIVATE_READ_REASON } from '../permissions/webSearch';
import {
  implementationPlanAllowsScope,
  implementationPlanMatchesBinding,
  parseImplementationPlanGrant,
  type ImplementationPlanGrantScope,
} from './implementationPlanGrant';

const APPROVAL_GRANT_VERSION = 'v4';

export interface ImplementationPlanAdmission {
  grant_id: string;
  decision: Extract<ApprovalDecision, { status: 'allow' }>;
}

export interface EffectiveToolAdmission {
  decision: ApprovalDecision | undefined;
  admission_provenance: import('../events/schema').ToolAdmissionProvenance;
}

export function effectiveToolAdmissions(input: {
  calls: readonly InternalEnrichedToolCall[];
  decisions: ReadonlyMap<string, ApprovalDecision>;
  chatApprovalGrants: ReadonlySet<string>;
  implementationPlanGrants: ReadonlySet<string>;
}): Map<string, EffectiveToolAdmission> {
  const effective = new Map<string, EffectiveToolAdmission>();
  for (const call of input.calls) {
    const explicit = input.decisions.get(call.id);
    if (explicit !== undefined) {
      effective.set(call.id, {
        decision: explicit,
        admission_provenance: {
          source: 'user_approval',
          decision: explicit.status,
          ...(explicit.status === 'allow' && explicit.scope !== undefined ? { scope: explicit.scope } : {}),
        },
      });
      continue;
    }
    if (
      call.tool_info.is_approval_required === true &&
      allowsChatApproval(call.tool_info) &&
      input.chatApprovalGrants.has(approvalGrantKey(call.tool_info))
    ) {
      effective.set(call.id, {
        decision: { status: 'allow', scope: 'chat' },
        admission_provenance: { source: 'chat_grant', decision: 'allow', scope: 'chat' },
      });
      continue;
    }
    const plan = implementationPlanAdmissionForCall(call, input.implementationPlanGrants);
    if (call.tool_info.is_approval_required === true && plan !== undefined) {
      effective.set(call.id, {
        decision: plan.decision,
        admission_provenance: { source: 'implementation_plan_grant', grant_id: plan.grant_id },
      });
      continue;
    }
    effective.set(call.id, { decision: undefined, admission_provenance: { source: 'automatic' } });
  }
  return effective;
}

/**
 * Server-owned eligibility for a durable chat-scoped approval. This only gates
 * which calls may *receive* chat scope; the scope's binding lives in the grant
 * key: sandbox exec keys carry an invocation digest over (purpose, command,
 * cwd, env) and registered-command keys carry the repository command id, so
 * approving one invocation never authorizes a different one. A failed,
 * unknown, or repository-mutating run never creates a commit receipt.
 */
export function allowsChatApproval(info: InternalToolCallInfo): boolean {
  if (secretPathReadBarsDurableGrant(info)) {
    return false;
  }
  if (info.implementation_plan_grant !== undefined) {
    return true;
  }
  return !tierBarsDurableGrant(info) && (info.effect === 'inspect' || info.effect === 'verify');
}

/**
 * Stored in the chat's approval grants by "Allow searches in this chat". It is one value per chat, so it never
 * matches an `approvalGrantKey`, and it only lifts the private-read hold for the designated search provider.
 */
export const SEARCH_CHAT_GRANT_KEY = JSON.stringify(['search_after_private_read', 'v1']);

/**
 * Whether a held search may offer "Allow searches in this chat". Only the designated search provider's call
 * held for a private read qualifies; every other search check still runs whatever the grant says.
 */
export function allowsSearchChatGrant(info: InternalToolCallInfo): boolean {
  return (
    info.search_provider_call === true &&
    info.tier_reason === SEARCH_AFTER_PRIVATE_READ_REASON &&
    info.implementation_plan_grant === undefined &&
    !secretPathReadBarsDurableGrant(info)
  );
}

/** Whether the approval card may offer a chat-scoped allow for this call. */
export function offersChatApproval(info: InternalToolCallInfo): boolean {
  return allowsChatApproval(info) || allowsSearchChatGrant(info);
}

/** A send, destructive, install or hint-escalated call is never covered by an argument-blind grant. */
function tierBarsDurableGrant(info: InternalToolCallInfo): boolean {
  if (info.tier_reason === undefined) {
    return info.tier === 3;
  }
  return GRANT_BARRED_TIER_REASONS.has(info.tier_reason);
}

/**
 * A private read (a sensitive path or a path-like argument) is never covered by a durable grant,
 * whatever its annotations say: the grant would then cover every later read of that path. Shared by
 * the chat and always scopes.
 */
function secretPathReadBarsDurableGrant(info: InternalToolCallInfo): boolean {
  return info.secret_path_read === true;
}

/**
 * Server-owned eligibility for a standing "Always allow this tool" grant: only a connector tool
 * that is read-only inspection, for the same argument-blindness reason as a chat grant.
 */
export function allowsToolGrant(info: InternalToolCallInfo): boolean {
  // A grant has no effect on the designated search provider, which has its own guarded path.
  return (
    info.type === 'mcp' &&
    info.effect === 'inspect' &&
    !secretPathReadBarsDurableGrant(info) &&
    !tierBarsDurableGrant(info) &&
    info.implementation_plan_grant === undefined &&
    info.search_provider_call !== true
  );
}

/**
 * Durable identity for a chat-scoped approval. The identity is derived by the
 * server from the enriched tool call, never accepted from the browser. The card's
 * destination and recipient are part of it so a grant never follows a call to a different target.
 */
export function approvalGrantKey(info: InternalToolCallInfo): string {
  const card = info.tier3_card ?? null;
  return JSON.stringify([
    APPROVAL_GRANT_VERSION,
    info.type,
    info.mcp_server_id,
    info.original_tool_name,
    card?.destination ?? null,
    card?.recipient ?? null,
    card?.destination_host ?? null,
  ]);
}

export function implementationPlanScopeForCall(
  call: InternalEnrichedToolCall,
): ImplementationPlanGrantScope | undefined {
  if (call.tool_info.mcp_server_id !== SANDBOX_MCP_SERVER_ID) {
    return undefined;
  }
  const scope = call.tool_info.implementation_plan_scope;
  if (scope === undefined) {
    return undefined;
  }
  const originalToolName = call.tool_info.original_tool_name;
  if (
    scope.kind === 'paths' &&
    (originalToolName === `${SANDBOX_APPLY_PATCH_TOOL_NAME}:edit` ||
      originalToolName === `${SANDBOX_REPLACE_TEXT_TOOL_NAME}:edit` ||
      originalToolName === `${SANDBOX_WRITE_FILE_TOOL_NAME}:edit`)
  ) {
    return scope;
  }
  if (
    scope.kind === 'command' &&
    originalToolName.startsWith(`${SANDBOX_RUN_REGISTERED_COMMAND_TOOL_NAME}:`) &&
    originalToolName.endsWith(`:${scope.command_id}`)
  ) {
    return scope;
  }
  return undefined;
}

function callIsAllowedByPlan(call: InternalEnrichedToolCall, grantValue: string): boolean {
  const grant = parseImplementationPlanGrant(grantValue);
  const scope = implementationPlanScopeForCall(call);
  const binding = call.tool_info.implementation_plan_binding;
  return (
    grant !== undefined &&
    scope !== undefined &&
    binding !== undefined &&
    implementationPlanMatchesBinding({ grant, binding }) &&
    implementationPlanAllowsScope({ grant, scope })
  );
}

export function implementationPlanGrantForCall(
  call: InternalEnrichedToolCall,
  grants: ReadonlySet<string>,
): string | undefined {
  return [...grants]
    .filter(grant => callIsAllowedByPlan(call, grant))
    .sort((left, right) => {
      const leftId = parseImplementationPlanGrant(left)?.grant_id ?? '';
      const rightId = parseImplementationPlanGrant(right)?.grant_id ?? '';
      return leftId.localeCompare(rightId) || left.localeCompare(right);
    })[0];
}

export function implementationPlanAdmissionForCall(
  call: InternalEnrichedToolCall,
  grants: ReadonlySet<string>,
): ImplementationPlanAdmission | undefined {
  const value = implementationPlanGrantForCall(call, grants);
  const grant = value === undefined ? undefined : parseImplementationPlanGrant(value);
  return grant === undefined ? undefined : { grant_id: grant.grant_id, decision: { status: 'allow', scope: 'once' } };
}

export function effectiveApprovalDecisions(input: {
  calls: readonly InternalEnrichedToolCall[];
  decisions: ReadonlyMap<string, ApprovalDecision>;
  chatApprovalGrants: ReadonlySet<string>;
  implementationPlanGrants: ReadonlySet<string>;
}): Map<string, ApprovalDecision> {
  const effective = new Map<string, ApprovalDecision>();
  for (const [id, admission] of effectiveToolAdmissions({
    calls: input.calls,
    decisions: input.decisions,
    chatApprovalGrants: input.chatApprovalGrants,
    implementationPlanGrants: input.implementationPlanGrants,
  })) {
    if (admission.decision !== undefined) {
      effective.set(id, admission.decision);
    }
  }
  return effective;
}

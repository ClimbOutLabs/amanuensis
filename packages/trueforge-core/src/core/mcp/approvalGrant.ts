import type { ApprovalDecision } from '../events/schema';
import type { InternalEnrichedToolCall, InternalToolCallInfo } from '../llm/LLMTypes';
import {
  SANDBOX_APPLY_PATCH_TOOL_NAME,
  SANDBOX_MCP_SERVER_ID,
  SANDBOX_REPLACE_TEXT_TOOL_NAME,
  SANDBOX_RUN_REGISTERED_COMMAND_TOOL_NAME,
  SANDBOX_WRITE_FILE_TOOL_NAME,
} from '../sandbox/Sandbox';
import {
  implementationPlanAllowsScope,
  implementationPlanMatchesBinding,
  parseImplementationPlanGrant,
  type ImplementationPlanGrantScope,
} from './implementationPlanGrant';

const APPROVAL_GRANT_VERSION = 'v3';

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

/** Server-owned eligibility for a durable chat-scoped approval. */
export function allowsChatApproval(info: InternalToolCallInfo): boolean {
  // Verification remains host-observed and exact-invocation scoped. A failed,
  // unknown, or repository-mutating run never creates a commit receipt.
  return info.implementation_plan_grant !== undefined || info.effect === 'inspect' || info.effect === 'verify';
}

/**
 * Durable identity for a chat-scoped approval. The identity is derived by the
 * server from the enriched tool call, never accepted from the browser.
 */
export function approvalGrantKey(info: InternalToolCallInfo): string {
  return JSON.stringify([APPROVAL_GRANT_VERSION, info.type, info.mcp_server_id, info.original_tool_name]);
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

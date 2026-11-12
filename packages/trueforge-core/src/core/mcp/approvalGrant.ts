import type { ApprovalDecision } from '../events/schema';
import type { InternalEnrichedToolCall, InternalToolCallInfo } from '../llm/LLMTypes';
import { BROWSER_CLICK_TOOL_NAME, BROWSER_OPEN_TOOL_NAME, isAmanBrowserCall } from '../permissions/browserToolNames';
import { MAPS_ASK_REASON } from '../permissions/mapsToolNames';
import {
  BROWSER_OPEN_SITE_GRANT_REASONS,
  CHAT_GRANTABLE_CONSEQUENCE_REASONS,
  GRANT_BARRED_TIER_REASONS,
  OWN_CALENDAR_CHANGE_REASONS,
  OWN_DRIVE_WRITE_REASONS,
} from '../permissions/tier';
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
 * What a chat-scoped approval on this call covers beyond the call itself, or null when it binds the call.
 * The one wider scope is a browser open the person vouched for by site: the server sets it, the card names
 * it, and the grant key binds it, so the three can never drift apart.
 */
export function chatGrantScope(info: InternalToolCallInfo): 'site' | null {
  return siteGrantableOpen(info) ? 'site' : null;
}

/**
 * A browser open whose chat grant may cover its site: one of Aman's own browser opens, under a reason the
 * site-grant set names, with a site on its card to bind to. A barred reason never qualifies, whatever the
 * set says, and neither does a private read.
 */
function siteGrantableOpen(info: InternalToolCallInfo): boolean {
  if (secretPathReadBarsDurableGrant(info) || tierBarsDurableGrant(info)) {
    return false;
  }
  if (!isAmanBrowserCall(info) || info.original_tool_name !== BROWSER_OPEN_TOOL_NAME) {
    return false;
  }
  if (info.tier_reason === undefined || !BROWSER_OPEN_SITE_GRANT_REASONS.has(info.tier_reason)) {
    return false;
  }
  const host = info.tier3_card?.destination_host ?? null;
  return host !== null && host !== '';
}

/**
 * Server-owned eligibility for "Always allow in this chat", the one chat-scoped grant. This only gates which calls may
 * *receive* chat scope; the scope's binding lives in the grant key: the tool and its destination, and for sandbox
 * exec an invocation digest over (purpose, command, cwd, env), so approving one command in a chat never authorizes a
 * different one or reaches another chat. A consequential action qualifies only when its card names a target for
 * the grant to be tied to; a send, a mail draft and a steered call never do. A map qualifies, unless it would
 * send something that looks like a secret. A browser open qualifies only by site, under the reasons
 * `chatGrantScope` names.
 */
export function allowsChatApproval(info: InternalToolCallInfo): boolean {
  if (secretPathReadBarsDurableGrant(info)) {
    return false;
  }
  if (info.implementation_plan_grant !== undefined) {
    return true;
  }
  if (isOwnCalendarChange(info) || mapsCardTakesLastingAnswer(info)) {
    return true;
  }
  if (isOwnDriveWrite(info)) {
    return true;
  }
  if (info.tier_reason !== undefined && CHAT_GRANTABLE_CONSEQUENCE_REASONS.has(info.tier_reason)) {
    return cardNamesTarget(info);
  }
  if (chatGrantScope(info) === 'site') {
    return true;
  }
  return !tierBarsDurableGrant(info) && (info.effect === 'inspect' || info.effect === 'verify');
}

/**
 * Whether the card names who or where the action goes: a destination or a recipient. An action whose card names
 * none has nothing for a chat grant to be tied to: the grant would cover any later call of the tool, whatever it
 * carries. The connector's own address does not count: it is the same on every call to that connector, so it
 * tells one action from another no better than the tool name.
 */
function cardNamesTarget(info: InternalToolCallInfo): boolean {
  const card = info.tier3_card ?? null;
  return [card?.destination, card?.recipient].some(target => typeof target === 'string' && target.trim() !== '');
}

/** A change to the person's own calendar with no guests; a guest change never qualifies, whatever its effect. */
function isOwnCalendarChange(info: InternalToolCallInfo): boolean {
  return info.tier_reason !== undefined && OWN_CALENDAR_CHANGE_REASONS.has(info.tier_reason);
}

/** A Drive write to the person's own files; it sends nothing to anyone, so it qualifies like an own-calendar change. */
function isOwnDriveWrite(info: InternalToolCallInfo): boolean {
  return info.tier_reason !== undefined && OWN_DRIVE_WRITE_REASONS.has(info.tier_reason);
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
 * Server-owned eligibility for a standing "Always allow everywhere" grant: only a connector tool
 * that is read-only inspection, for the same argument-blindness reason as a chat grant. A call the
 * classifier stamped with a grant scope key is the one exception: the key itself is the scope
 * (a Home Assistant domain or the one entity), so the grant is never wider than the key says.
 * A change to the person's own calendar is answered per chat, so it never gets one. A map gets one, which lets
 * maps run without asking.
 */
export function allowsToolGrant(info: InternalToolCallInfo): boolean {
  // A grant has no effect on the designated search provider, which has its own guarded path.
  if (
    secretPathReadBarsDurableGrant(info) ||
    tierBarsDurableGrant(info) ||
    info.implementation_plan_grant !== undefined ||
    info.search_provider_call === true
  ) {
    return false;
  }
  return (
    mapsCardTakesLastingAnswer(info) ||
    isOwnDriveWrite(info) ||
    (info.type === 'mcp' && info.effect === 'inspect') ||
    (info.type === 'mcp' && info.grant_tool_name !== undefined)
  );
}

/**
 * The chat-scoped refusal key for a call, or null when a "no" to it lasts only the turn. Only a
 * browser open or click records one: the person turned down a page, or a click on one, and the
 * refusal is kept on the session so the rest of the chat refuses the same identity with no new
 * card. The key is the approval grant key, so an open under the site scope is refused for the
 * whole site, exactly as a grant on it would have covered the site.
 */
export function chatRefusalKey(info: InternalToolCallInfo): string | null {
  if (!isAmanBrowserCall(info)) {
    return null;
  }
  if (info.original_tool_name !== BROWSER_OPEN_TOOL_NAME && info.original_tool_name !== BROWSER_CLICK_TOOL_NAME) {
    return null;
  }
  return approvalGrantKey(info);
}

/**
 * Whether this is the card of the assistant's own maps tool that a lasting answer may cover. "Always allow in
 * this chat" stops the question for the chat, and "Always allow everywhere" lets maps run without asking from
 * then on. A map that asks because it would send something that looks like a secret offers neither.
 */
export function mapsCardTakesLastingAnswer(info: InternalToolCallInfo): boolean {
  return info.type === 'truefoundry-system' && info.tier_reason === MAPS_ASK_REASON;
}

/**
 * Whether a call waits for the person's answer. A call that matches a "no" from earlier in this turn
 * gets no new card: the run refuses it as that same "no", so rewording a search cannot ask again.
 */
export function awaitsApproval(input: {
  call: InternalEnrichedToolCall;
  decisions: ReadonlyMap<string, ApprovalDecision>;
  deniedApprovalIdentities: ReadonlySet<string>;
}): boolean {
  return (
    input.call.tool_info.is_approval_required === true &&
    !input.decisions.has(input.call.id) &&
    !input.deniedApprovalIdentities.has(approvalGrantKey(input.call.tool_info))
  );
}

/**
 * Durable identity for a chat-scoped approval. The identity is derived by the
 * server from the enriched tool call, never accepted from the browser. The card's
 * destination and recipient are part of it so a grant never follows a call to a different target.
 * A site-scoped open is the one exception: its identity is the tool, the reason it was given on and
 * the site, never the one address, so the grant covers the site the person approved and nothing else.
 */
export function approvalGrantKey(info: InternalToolCallInfo): string {
  const card = info.tier3_card ?? null;
  if (chatGrantScope(info) === 'site') {
    return JSON.stringify([
      APPROVAL_GRANT_VERSION,
      info.type,
      info.mcp_server_id,
      info.original_tool_name,
      null,
      null,
      card?.destination_host ?? null,
      info.tier_reason ?? null,
    ]);
  }
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

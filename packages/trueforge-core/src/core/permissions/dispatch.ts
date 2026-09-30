/**
 * Sentinel pre-dispatch verification, run immediately before invocation of an
 * approved Tier 3 call.
 *
 * Re-verifies single-use approval tokens byte-for-byte against the exact
 * parameters about to be executed (rebuilding the canonical shell form with
 * fresh file hashes, or the tracked-execution content/argv hashes). Anything
 * covered by the hash that changed after approval invalidates the token and
 * the agent must request approval again. A valid tracked-execution approval
 * records its (content_hash, argv_hash) grant so byte-identical re-execution
 * within the conversation does not re-escalate.
 *
 * Also enforces the stale-context guard: if offline mode was enabled between
 * classification and dispatch, network-required and external-service Tier 3
 * actions auto-deny even with an approval.
 */
import {
  actionIdFor,
  verifyApprovalToken,
  type ApprovalToken,
} from './approvalTokens';
import { extractCardFields } from './extractorRegistry';
import { hashArgv, matchAllowlist, OFFLINE_SHELL_COMMANDS, parseSimpleCommand } from './shellAllowlist';
import {
  extractExecutedFileOperand,
  sha256FileContent,
  splitWordsLenient,
  canonicalFileIdentity,
} from './trackedExecutables';
import { requiresNetwork, provenanceForToolType } from './networkRequirements';
import { canonicalShellForm } from './classifier';
import type { Tier, TierDecision, TrackedExecutionBinding } from './tier';
import type { ShellApprovalBinding } from './approvalTokens';
import type { SentinelCallIdentity, SentinelServices } from './context';

export interface VerifiableCall {
  tool_name: string;
  tool_type: 'truefoundry-system' | 'mcp';
  canonical_params: Record<string, unknown>;
  tier: Tier;
  approval_token_id: string | null;
  approval_binding: TrackedExecutionBinding | null;
  shell_binding: ShellApprovalBinding | null;
}

export interface DispatchCheckContext extends SentinelCallIdentity {
  services: SentinelServices;
  offline: boolean;
}

/** Build a VerifiableCall from a classified tool call's host-only info. */
export function verifiableCallFromDecision(input: {
  tool_name: string;
  tool_type: 'truefoundry-system' | 'mcp';
  canonical_params: Record<string, unknown>;
  decision: TierDecision;
}): VerifiableCall {
  return {
    tool_name: input.tool_name,
    tool_type: input.tool_type,
    canonical_params: input.canonical_params,
    tier: input.decision.tier,
    approval_token_id: input.decision.approval_token_id,
    approval_binding: input.decision.approval_binding,
    shell_binding: input.decision.shell_binding,
  };
}

function stringParam(params: Record<string, unknown>, key: string): string | null {
  const value = params[key];
  return typeof value === 'string' ? value : null;
}

function envOverrides(params: Record<string, unknown>): Record<string, string> | null {
  const raw = params['env'];
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  return Object.fromEntries(
    Object.entries(raw).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

function offlineViolation(call: VerifiableCall, ctx: DispatchCheckContext): string | undefined {
  if (call.tool_name === 'exec') {
    const command = stringParam(call.canonical_params, 'command') ?? '';
    const parsed = parseSimpleCommand(command);
    const matched = parsed !== undefined ? matchAllowlist(parsed, ctx.services.shell_allowlist) : undefined;
    const commandName = parsed?.argv[0];
    if (
      parsed === undefined ||
      matched === undefined ||
      commandName === undefined ||
      !OFFLINE_SHELL_COMMANDS.includes(commandName)
    ) {
      return 'Auto-denied: offline mode is on and this shell command is not in the offline subset.';
    }
    return undefined;
  }
  if (
    requiresNetwork({ tool_name: call.tool_name, provenance: provenanceForToolType(call.tool_type) })
  ) {
    return 'Auto-denied: offline mode is on and this tool needs network access.';
  }
  if (extractCardFields({ tool_name: call.tool_name, canonical_params: call.canonical_params }).external_service) {
    return 'Auto-denied: offline mode is on and external-service actions are disabled.';
  }
  return undefined;
}

/**
 * Returns an error message when the call must not execute, or undefined when
 * it is cleared to run. Only approved Tier 3 calls need verification; Tier
 * 1/2 return undefined immediately.
 */
export function verifyPreDispatch(input: {
  call: VerifiableCall;
  ctx: DispatchCheckContext;
}): string | undefined {
  const { call, ctx } = input;
  const { services } = ctx;

  if (call.tier !== 3) {
    return undefined;
  }

  // Stale-context guard: offline since classification auto-denies.
  if (ctx.offline) {
    const violation = offlineViolation(call, ctx);
    if (violation !== undefined) {
      return violation;
    }
  }

  const tokenId = call.approval_token_id;
  if (tokenId === null) {
    // Tier 3 without a token: auto-denied decisions never reach dispatch with
    // approval, so a missing token is a host bug. Fail closed.
    return 'Approval token missing for a Tier 3 action; request approval again.';
  }
  const token: ApprovalToken | undefined = services.token_store.redeem({ token_id: tokenId });
  if (token === undefined) {
    return 'Approval token is invalid or was already used; request approval again.';
  }

  // Rebuild the canonical params identically to classify time, with fresh hashes.
  if (call.shell_binding !== null) {
    const form = canonicalShellForm({
      command: stringParam(call.canonical_params, 'command') ?? '',
      cwd: stringParam(call.canonical_params, 'cwd'),
      env: envOverrides(call.canonical_params),
      allowlist: services.shell_allowlist,
      workspace_cwd: ctx.workspace_cwd,
    });
    const verification = verifyApprovalToken({
      token,
      action_id: actionIdFor({ tool_name: call.tool_name, canonical_params: form }),
      canonical_params: form,
    });
    return verification.valid ? undefined : `Approval invalid: ${verification.reason}; request approval again.`;
  }

  if (call.approval_binding !== null) {
    const binding = call.approval_binding;
    const command = stringParam(call.canonical_params, 'command') ?? '';
    const parsed = parseSimpleCommand(command);
    const argv = parsed !== undefined ? parsed.argv : splitWordsLenient(command);
    const executedOperand = extractExecutedFileOperand({ argv });
    const identityCwd = stringParam(call.canonical_params, 'cwd') ?? ctx.workspace_cwd ?? '/';
    const identity =
      executedOperand === undefined ? null : canonicalFileIdentity({ p: executedOperand, cwd: identityCwd });
    const contentHash = identity === null ? null : sha256FileContent(identity);
    const argvHash = hashArgv(argv);
    const grantParams = {
      file_identity: binding.file_identity,
      content_hash: contentHash,
      argv_hash: argvHash,
      argv,
    };
    const verification = verifyApprovalToken({
      token,
      action_id: actionIdFor({ tool_name: call.tool_name, canonical_params: grantParams }),
      canonical_params: grantParams,
    });
    if (!verification.valid) {
      return `Approval invalid: ${verification.reason}; request approval again.`;
    }
    if (contentHash === null || identity !== binding.file_identity) {
      return 'Approval invalid: the approved script changed since approval; request approval again.';
    }
    services.tracked_store.recordGrant({
      conversation_id: ctx.conversation_id,
      file_identity: binding.file_identity,
      content_hash: contentHash,
      argv_hash: argvHash,
    });
    return undefined;
  }

  const verification = verifyApprovalToken({
    token,
    action_id: actionIdFor({ tool_name: call.tool_name, canonical_params: call.canonical_params }),
    canonical_params: call.canonical_params,
  });
  return verification.valid ? undefined : `Approval invalid: ${verification.reason}; request approval again.`;
}

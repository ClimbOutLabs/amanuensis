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
  canonicalFileIdentity,
  canonicalWriteTarget,
  extractExecutedFileOperand,
  sha256FileContent,
  splitWordsLenient,
} from './trackedExecutables';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { requiresNetwork, provenanceForToolType } from './networkRequirements';
import { canonicalShellForm } from './classifier';
import type { Tier, TrackedExecutionBinding } from './tier';
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
 * Tier 2 decisions are notice-only, but they still promise workspace
 * containment: the classifier escalates out-of-workspace cwd and operands.
 * Re-verify that containment against the current filesystem state, because a
 * symlinked parent repointed between classification and dispatch could
 * otherwise turn an in-workspace operation into an out-of-workspace one.
 */
function verifyTier2Containment(input: {
  call: VerifiableCall;
  workspace_root: string;
}): string | undefined {
  const { call, workspace_root } = input;
  let root: string;
  try {
    root = realpathSync(workspace_root);
  } catch {
    return 'Tier 2 workspace check failed at dispatch; request approval again.';
  }
  const insideRoot = (identity: string): boolean =>
    identity === root || identity.startsWith(`${root}${path.sep}`);

  if (call.tool_name === 'write_file' || call.tool_name === 'apply_patch' || call.tool_name === 'replace_text') {
    const target = stringParam(call.canonical_params, 'path') ?? stringParam(call.canonical_params, 'target');
    if (target !== null) {
      const cwd = stringParam(call.canonical_params, 'cwd') ?? workspace_root;
      // The target may not exist yet: resolve via its parent directory.
      const identity = canonicalWriteTarget({ p: target, cwd });
      if (identity === null || !insideRoot(identity)) {
        return 'Tier 2 write target is outside the workspace at dispatch; request approval again.';
      }
    }
    return undefined;
  }

  if (call.tool_name === 'exec') {
    const command = stringParam(call.canonical_params, 'command') ?? '';
    const parsed = parseSimpleCommand(command);
    if (parsed === undefined) {
      return 'Tier 2 shell command cannot be parsed at dispatch; request approval again.';
    }
    const cwd = stringParam(call.canonical_params, 'cwd') ?? workspace_root;
    const cwdIdentity = canonicalFileIdentity({ p: cwd, cwd: '/' });
    if (cwdIdentity === null || !insideRoot(cwdIdentity)) {
      return 'Tier 2 shell working directory is outside the workspace at dispatch; request approval again.';
    }
    for (const token of parsed.argv.slice(1)) {
      if (token.startsWith('-')) {
        continue;
      }
      const identity =
        canonicalFileIdentity({ p: token, cwd }) ?? canonicalWriteTarget({ p: token, cwd });
      // Unresolvable operands were not bound at classify time; only a
      // resolved-outside operand invalidates the Tier 2 grant.
      if (identity !== null && !insideRoot(identity)) {
        return 'Tier 2 shell operand is outside the workspace at dispatch; request approval again.';
      }
    }
    return undefined;
  }

  return undefined;
}

/**
 * Returns an error message when the call must not execute, or undefined when
 * it is cleared to run. Tier 3 calls are verified against their approval
 * token; Tier 2 calls get a workspace-containment re-check; Tier 1 passes
 * through.
 */
export function verifyPreDispatch(input: {
  call: VerifiableCall;
  ctx: DispatchCheckContext;
}): string | undefined {
  const { call, ctx } = input;
  const { services } = ctx;

  if (call.tier === 2) {
    const workspaceRoot = ctx.workspace_cwd;
    if (workspaceRoot === null) {
      return undefined;
    }
    return verifyTier2Containment({ call, workspace_root: workspaceRoot });
  }

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

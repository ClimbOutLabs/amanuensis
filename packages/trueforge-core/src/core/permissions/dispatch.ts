/**
 * Sentinel pre-dispatch verification, run immediately before invocation of an
 * approved Tier 3 call or a Tier 2 call that asked.
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
 * classification and dispatch, network-required and external-service actions
 * that need approval auto-deny even with an approval.
 */
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { absolutePatchTarget, applyPatchTargets } from './applyPatchTargets';
import type { ConnectorBinding, ShellApprovalBinding } from './approvalTokens';
import { actionIdFor, verifyApprovalToken, type ApprovalToken } from './approvalTokens';
import { canonicalShellFormFor } from './classifier';
import type { SentinelCallIdentity, SentinelServices } from './context';
import { extractCardFields } from './extractorRegistry';
import { provenanceForToolType, requiresNetwork } from './networkRequirements';
import {
  hashArgv,
  matchAllowlist,
  OFFLINE_SHELL_COMMANDS,
  parseReadOnlyList,
  parseSimpleCommand,
  type ParsedSimpleCommand,
  type ShellAllowlistConfig,
} from './shellAllowlist';
import type { Tier, TrackedExecutionBinding } from './tier';
import {
  canonicalFileIdentity,
  canonicalWriteIdentity,
  canonicalWriteTarget,
  contentDigest,
  extractExecutedFileOperand,
  isUnderRoot,
  lexicalPath,
  splitWordsLenient,
  writeTargetTouchesGitControl,
  writeTargetTouchesSandboxTools,
  type FileDigest,
  type PathResolution,
} from './trackedExecutables';

export interface VerifiableCall {
  tool_name: string;
  tool_type: 'truefoundry-system' | 'mcp';
  canonical_params: Record<string, unknown>;
  tier: Tier;
  approval_token_id: string | null;
  approval_binding: TrackedExecutionBinding | null;
  shell_binding: ShellApprovalBinding | null;
  /** The connector as it is now, rebuilt at dispatch; absent when the call has no connector binding. */
  connector?: ConnectorBinding | undefined;
}

export interface DispatchCheckContext extends SentinelCallIdentity {
  services: SentinelServices;
  offline: boolean;
  /** How the call's paths are resolved; must be the value the classifier used. Absent means the server's filesystem. */
  path_resolution?: PathResolution | undefined;
  /** Reads file digests from the remote sandbox the call runs in. */
  file_digest?: FileDigest | undefined;
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
  if (requiresNetwork({ tool_name: call.tool_name, provenance: provenanceForToolType(call.tool_type) })) {
    return 'Auto-denied: offline mode is on and this tool needs network access.';
  }
  if (extractCardFields({ tool_name: call.tool_name, canonical_params: call.canonical_params }).external_service) {
    return 'Auto-denied: offline mode is on and external-service actions are disabled.';
  }
  return undefined;
}

/** The working directory a call names. A relative one is read below the workspace in a remote sandbox, as the classifier read it. */
function callCwd(input: {
  params: Record<string, unknown>;
  workspace_root: string;
  resolution: PathResolution | undefined;
}): string {
  const raw = stringParam(input.params, 'cwd');
  if (raw === null) {
    return input.workspace_root;
  }
  return input.resolution === 'remote' ? (lexicalPath({ p: raw, cwd: input.workspace_root }) ?? '/') : raw;
}

/**
 * Tier 2 decisions and silent (Tier 1) shell commands promise workspace
 * containment whether or not they asked: the classifier escalates
 * out-of-workspace cwd and operands.
 * Re-verify that containment against the current filesystem state, because a
 * symlinked parent repointed between classification and dispatch could
 * otherwise turn an in-workspace operation into an out-of-workspace one.
 */
function verifyTier2Containment(input: {
  call: VerifiableCall;
  workspace_root: string;
  resolution: PathResolution | undefined;
  shellAllowlist: ShellAllowlistConfig;
}): string | undefined {
  const { call, workspace_root, resolution, shellAllowlist } = input;
  let root: string | null;
  try {
    root = resolution === 'remote' ? lexicalPath({ p: workspace_root, cwd: '/' }) : realpathSync(workspace_root);
  } catch {
    root = null;
  }
  if (root === null) {
    return 'Tier 2 workspace check failed at dispatch; request approval again.';
  }
  const containingRoot = root;
  const separator = resolution === 'remote' ? '/' : path.sep;
  const insideRoot = (identity: string): boolean => isUnderRoot({ identity, root: containingRoot, separator });

  if (call.tool_name === 'write_file' || call.tool_name === 'apply_patch' || call.tool_name === 'replace_text') {
    const callDirectory = callCwd({ params: call.canonical_params, workspace_root, resolution });
    // An apply_patch changes the files its patch names; a path argument on it is not a target.
    const patchTargets =
      call.tool_name === 'apply_patch'
        ? applyPatchTargets({ params: call.canonical_params, workspace_root, cwd: callDirectory })
        : undefined;
    if (patchTargets?.status === 'invalid') {
      return 'Tier 2 write target is outside the workspace at dispatch; request approval again.';
    }
    const targets =
      patchTargets === undefined
        ? [stringParam(call.canonical_params, 'path') ?? stringParam(call.canonical_params, 'target')].filter(
            (target): target is string => target !== null,
          )
        : patchTargets.paths.map(relative_path => absolutePatchTarget({ workspace_root, relative_path, resolution }));
    for (const target of targets) {
      const identity = canonicalWriteIdentity({ p: target, cwd: callDirectory, resolution });
      if (identity === null || !insideRoot(identity)) {
        return 'Tier 2 write target is outside the workspace at dispatch; request approval again.';
      }
      if (writeTargetTouchesGitControl({ p: target, cwd: callDirectory, resolution })) {
        return 'Tier 2 write target is Git control state at dispatch; request approval again.';
      }
      if (writeTargetTouchesSandboxTools({ p: target, cwd: callDirectory, roots: [workspace_root], resolution })) {
        return 'Tier 2 write target is a sandbox tool folder at dispatch; request approval again.';
      }
    }
    return undefined;
  }

  if (call.tool_name === 'exec') {
    const command = stringParam(call.canonical_params, 'command') ?? '';
    const parsed = parseSimpleCommand(command);
    const list = parsed === undefined ? parseReadOnlyList({ command, config: shellAllowlist }) : undefined;
    if (parsed === undefined && list === undefined) {
      return 'Tier 2 shell command cannot be parsed at dispatch; request approval again.';
    }
    const cwd = callCwd({ params: call.canonical_params, workspace_root, resolution });
    const cwdIdentity = canonicalFileIdentity({ p: cwd, cwd: '/', resolution });
    if (cwdIdentity === null || !insideRoot(cwdIdentity)) {
      return 'Tier 2 shell working directory is outside the workspace at dispatch; request approval again.';
    }
    const operandOutside = (input: { parsed: ParsedSimpleCommand; cwd: string }): boolean =>
      input.parsed.argv.slice(1).some(token => {
        if (token.startsWith('-')) {
          return false;
        }
        const identity =
          canonicalFileIdentity({ p: token, cwd: input.cwd, resolution }) ??
          canonicalWriteTarget({ p: token, cwd: input.cwd, resolution });
        // Unresolvable operands were not bound at classify time; only a
        // resolved-outside operand invalidates the Tier 2 grant.
        return identity !== null && !insideRoot(identity);
      });
    if (parsed !== undefined) {
      return operandOutside({ parsed, cwd })
        ? 'Tier 2 shell operand is outside the workspace at dispatch; request approval again.'
        : undefined;
    }
    let stepCwd = cwd;
    for (const step of list?.steps ?? []) {
      if (step.kind === 'run') {
        if (operandOutside({ parsed: step.parsed, cwd: stepCwd })) {
          return 'Tier 2 shell operand is outside the workspace at dispatch; request approval again.';
        }
        continue;
      }
      const target = canonicalFileIdentity({ p: step.dir, cwd: stepCwd, resolution });
      if (target === null || !insideRoot(target)) {
        return 'Tier 2 shell working directory is outside the workspace at dispatch; request approval again.';
      }
      stepCwd = target;
    }
    return undefined;
  }

  return undefined;
}

/** File-write tools whose sandbox writes can run without a card, so they are re-checked at dispatch. */
export const SANDBOX_FILE_WRITE_TOOLS: ReadonlySet<string> = new Set(['write_file', 'apply_patch', 'replace_text']);

/**
 * Returns an error message when the call must not execute, or undefined when
 * it is cleared to run. Tier 3 calls and Tier 2 calls that asked are verified
 * against their approval token; every Tier 2 call and every silent shell
 * command also gets a workspace-containment re-check; other Tier 1 calls and
 * relaxed Tier 2 pass through.
 */
export async function verifyPreDispatch(input: {
  call: VerifiableCall;
  ctx: DispatchCheckContext;
}): Promise<string | undefined> {
  const { call, ctx } = input;
  const { services } = ctx;

  if (call.tier === 1) {
    // Only shell commands and sandbox file writes are silent because of a containment rule that can change underfoot.
    if (call.tool_name !== 'exec' && !SANDBOX_FILE_WRITE_TOOLS.has(call.tool_name)) {
      return undefined;
    }
    const workspaceRoot = ctx.workspace_cwd;
    // Silent only because it was contained; with no workspace there is nothing to check against.
    return workspaceRoot === null
      ? 'No workspace is set for this shell command at dispatch; request approval again.'
      : verifyTier2Containment({
          call,
          workspace_root: workspaceRoot,
          resolution: ctx.path_resolution,
          shellAllowlist: services.shell_allowlist,
        });
  }

  if (call.tier === 2) {
    const workspaceRoot = ctx.workspace_cwd;
    const containmentError =
      workspaceRoot === null
        ? undefined
        : verifyTier2Containment({
            call,
            workspace_root: workspaceRoot,
            resolution: ctx.path_resolution,
            shellAllowlist: services.shell_allowlist,
          });
    if (containmentError !== undefined || call.approval_token_id === null) {
      return containmentError;
    }
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
  const token: ApprovalToken | undefined = await services.token_store.redeem({
    token_id: tokenId,
    tenant_id: ctx.tenant_id,
    created_by: ctx.created_by,
  });
  if (token === undefined) {
    return 'Approval token is invalid or was already used; request approval again.';
  }

  // Rebuild the canonical params identically to classify time, with fresh hashes.
  if (call.shell_binding !== null) {
    const form = await canonicalShellFormFor({
      command: stringParam(call.canonical_params, 'command') ?? '',
      cwd: stringParam(call.canonical_params, 'cwd'),
      env: envOverrides(call.canonical_params),
      allowlist: services.shell_allowlist,
      workspace_cwd: ctx.workspace_cwd,
      path_resolution: ctx.path_resolution,
      file_digest: ctx.file_digest,
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
    const identityCwd =
      ctx.path_resolution === 'remote' && ctx.workspace_cwd !== null
        ? callCwd({ params: call.canonical_params, workspace_root: ctx.workspace_cwd, resolution: 'remote' })
        : (stringParam(call.canonical_params, 'cwd') ?? ctx.workspace_cwd ?? '/');
    const identity =
      executedOperand === undefined
        ? null
        : canonicalFileIdentity({ p: executedOperand, cwd: identityCwd, resolution: ctx.path_resolution });
    if (ctx.path_resolution === 'remote' && ctx.file_digest === undefined) {
      // The sandbox offers no way to read its files, so there is no content to bind and no grant to keep:
      // the token covers the call's own parameters and the file's normalized path, and every run asks again.
      const sameFile = identity !== null && identity === binding.file_identity;
      const verified = verifyApprovalToken({
        token,
        action_id: actionIdFor({ tool_name: call.tool_name, canonical_params: call.canonical_params }),
        canonical_params: call.canonical_params,
      });
      if (!sameFile) {
        return 'Approval invalid: the approved script path changed since approval; request approval again.';
      }
      return verified.valid ? undefined : `Approval invalid: ${verified.reason}; request approval again.`;
    }
    const contentHash =
      identity === null
        ? null
        : await contentDigest({ identity, resolution: ctx.path_resolution, digest: ctx.file_digest });
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
    action_id: actionIdFor({
      tool_name: call.tool_name,
      canonical_params: call.canonical_params,
      connector: call.connector,
    }),
    canonical_params: call.canonical_params,
  });
  return verification.valid ? undefined : `Approval invalid: ${verification.reason}; request approval again.`;
}

/**
 * Sentinel tier classifier: the single authoritative `classifyTier(action)`.
 *
 * Full action matrix, fail-closed on anything unrecognized. Ordering per the
 * spec: offline auto-deny first; write-then-execute check before allowlist
 * matching; allowlist before Tier 3; extractor fallback for external-service
 * actions; MCP hints escalate-only, never lower. Returns a TierDecision with
 * stable reason codes, the Tier 3 card when required, Tier 2 matched
 * files/kind, and the tracked-execution approval binding.
 */
import path from 'path';
import { realpathSync } from 'fs';
import {
  actionIdFor,
  normalizeCwd,
  type ShellApprovalBinding,
} from './approvalTokens';
import {
  autoDenyDecision,
  tier1Decision,
  tier2Decision,
  tier3Decision,
  type Tier2ActionKind,
  type TierDecision,
  type TrackedExecutionBinding,
} from './tier';
import { extractCardFields } from './extractorRegistry';
import {
  hashArgv,
  matchAllowlist,
  OFFLINE_SHELL_COMMANDS,
  parseSimpleCommand,
  type ParsedSimpleCommand,
  type ShellAllowlistConfig,
} from './shellAllowlist';
import {
  canonicalFileIdentity,
  canonicalWriteTarget,
  extractExecutedFileOperand,
  isInsideWorkspace,
  sha256FileContent,
  splitCompoundSegments,
  splitWordsLenient,
  type TrackedExecutableScope,
} from './trackedExecutables';
import { requiresNetwork, provenanceForToolType } from './networkRequirements';
import { UNKNOWN_TOOL_NAME } from '../llm/LLMTypes';
import { isRunnerWorkflow } from './runner';
import { classifyContextFor, type SentinelCallIdentity, type SentinelHostContext, type SentinelServices } from './context';
import { recordClassificationAudit } from './audit';

export interface SentinelAction {
  /** Original tool name (sandbox name or mcp server tool name). */
  tool_name: string;
  /** The exact arguments the server will act on. */
  canonical_params: Record<string, unknown>;
  /** 'truefoundry-system' for sandbox/first-party tools, 'mcp' for MCP tools. */
  tool_type: 'truefoundry-system' | 'mcp';
  /**
   * Platform-owned MCP server id. Empty for system tools; UNKNOWN_TOOL_NAME
   * ('unknown') for the web provider's tool and other tools not from a
   * configured MCP server; the configured server id for real MCP tools.
   */
  mcp_server_id: string;
  /** Sandbox command effect when the action ran through the sandbox effect layer. */
  sandbox_effect?: string | undefined;
  mcp_hints: {
    read_only_hint?: boolean | undefined;
    destructive_hint?: boolean | undefined;
    open_world_hint?: boolean | undefined;
  };
}

export interface ClassifyContext extends SentinelCallIdentity {
  services: SentinelServices;
}

const SENSITIVE_PATH_PATTERNS = [
  /(^|\/)\.ssh(\/|$)/,
  /(^|\/)\.gnupg(\/|$)/,
  /(^|\/)\.env(\.|$|$)/,
  /credential/i,
  /secret/i,
  /(^|\/)[^/]*\.pem$/,
  /(^|\/)[^/]*\.key$/,
  /token/i,
];

function isSensitivePath(p: string): boolean {
  return SENSITIVE_PATH_PATTERNS.some(pattern => pattern.test(p));
}

/** Collect string param values that look like paths for sensitive-read detection. */
function sensitiveReadHit(params: Record<string, unknown>): boolean {
  const keys = ['path', 'paths', 'file', 'files', 'target', 'operand', 'command'];
  for (const key of keys) {
    const value = params[key];
    if (typeof value === 'string') {
      if (key === 'command') {
        for (const token of splitWordsLenient(value)) {
          if (isSensitivePath(token)) {
            return true;
          }
        }
      } else if (isSensitivePath(value)) {
        return true;
      }
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string' && isSensitivePath(item)) {
          return true;
        }
      }
    }
  }
  return false;
}

function stringParam(params: Record<string, unknown>, key: string): string | null {
  const value = params[key];
  return typeof value === 'string' ? value : null;
}

function firstSentence(text: string): string {
  const trimmed = text.trim();
  const match = /^[^.!?\n]+[.!?]?/.exec(trimmed);
  return (match !== null ? match[0] : trimmed).trim().slice(0, 280);
}

function plainWhy(agentIntent: string | null): string {
  if (agentIntent === null || agentIntent.trim() === '') {
    return 'The agent did not state a reason.';
  }
  return firstSentence(agentIntent);
}

function basenameOf(p: string): string {
  const base = p.split('/').pop() ?? p;
  return base === '' ? p : base;
}

function workspaceScope(ctx: ClassifyContext): TrackedExecutableScope {
  return {
    tenant_id: ctx.tenant_id,
    created_by: ctx.created_by,
    repository_id: ctx.repository_id,
    workspace_cwd: ctx.workspace_cwd,
  };
}

/** Resolve a cwd for identity work: the call cwd, else the workspace, else root. */
function resolveIdentityCwd(ctx: ClassifyContext, cwd: string | null): string {
  return cwd ?? ctx.workspace_cwd ?? '/';
}

/** Canonical identities of the non-flag tokens of a parsed simple command. */
function operandIdentities(parsed: ParsedSimpleCommand, cwd: string): string[] {
  const out: string[] = [];
  for (const token of parsed.argv.slice(1)) {
    if (token.startsWith('-')) {
      continue;
    }
    const identity = canonicalFileIdentity({ p: token, cwd });
    if (identity !== null) {
      out.push(identity);
    }
  }
  return out;
}

/**
 * True when every non-flag operand of a parsed simple command resolves inside
 * the workspace. An existing operand resolves by its own realpath (so a
 * symlinked file pointing outside is caught); a not-yet-existing operand
 * resolves via its parent directory (so a symlinked parent escaping the
 * workspace is caught even before the file is created). Anything
 * unresolvable fails closed.
 */
function shellOperandsInsideWorkspace(input: {
  parsed: ParsedSimpleCommand;
  cwd: string;
  workspace_root: string;
}): boolean {
  let root: string;
  try {
    root = realpathSync(input.workspace_root);
  } catch {
    return false;
  }
  for (const token of input.parsed.argv.slice(1)) {
    if (token.startsWith('-')) {
      continue;
    }
    const identity =
      canonicalFileIdentity({ p: token, cwd: input.cwd }) ?? canonicalWriteTarget({ p: token, cwd: input.cwd });
    if (identity === null) {
      return false;
    }
    if (!(identity === root || identity.startsWith(`${root}${path.sep}`))) {
      return false;
    }
  }
  return true;
}

interface CanonicalShellForm {
  kind: 'simple' | 'compound';
  argv: string[];
  argv0_resolved: string | null;
  raw_command: string;
  cwd_resolved: string | null;
  env_overrides: Record<string, string>;
  file_hashes: Record<string, string>;
}

/**
 * Canonical form of a shell action: what the approval token binds to. Rebuilt
 * identically at pre-dispatch re-verification.
 */
const INLINE_CODE_FLAGS = new Set(['-c', '-e', '--eval', '--command']);

/**
 * Recursively hash file operands hidden inside -c style inline code.
 * `sh -c 'sh /ws/payload.sh'` parses as a simple command where
 * extractExecutedFileOperand bails on -c, leaving the inner script unbound.
 * Depth is bounded to prevent pathological recursion.
 */
function hashInlineCodeOperands(input: {
  argv: readonly string[];
  cwd: string;
  hashFile: (p: string) => void;
  depth: number;
}): void {
  if (input.depth > 3) {
    return;
  }
  for (let i = 0; i < input.argv.length; i++) {
    const flag = input.argv[i];
    if (flag === undefined || !INLINE_CODE_FLAGS.has(flag)) {
      continue;
    }
    const code = input.argv[i + 1];
    if (typeof code !== 'string' || code.length === 0) {
      continue;
    }
    // The inline code is itself a shell command; scan its segments.
    for (const segment of splitCompoundSegments(code)) {
      const segParsed = parseSimpleCommand(segment);
      const segArgv = segParsed !== undefined ? segParsed.argv : splitWordsLenient(segment);
      const operand = extractExecutedFileOperand({ argv: segArgv });
      if (operand !== undefined) {
        const identity = canonicalFileIdentity({ p: operand, cwd: input.cwd });
        if (identity !== null) {
          input.hashFile(identity);
        }
      }
      // Recurse for nested -c (e.g. sh -c 'sh -c "sh /ws/x.sh"').
      hashInlineCodeOperands({ argv: segArgv, cwd: input.cwd, hashFile: input.hashFile, depth: input.depth + 1 });
    }
    // Also scan raw tokens in the inline code for $(), backticks, <() hidden
    // scripts, mirroring the compound branch's metachar-stripping scan.
    for (const token of splitWordsLenient(code)) {
      if (token.startsWith('-')) {
        continue;
      }
      const cleaned = token.replace(/^[$`<(]+/, '').replace(/[)>;|&`]+$/, '');
      if (cleaned.length === 0) {
        continue;
      }
      const identity = canonicalFileIdentity({ p: cleaned, cwd: input.cwd });
      if (identity !== null) {
        input.hashFile(identity);
      }
    }
  }
}

export function canonicalShellForm(input: {
  command: string;
  cwd: string | null;
  env: Record<string, string> | null;
  allowlist: ShellAllowlistConfig;
  workspace_cwd: string | null;
}): CanonicalShellForm {
  const parsed = parseSimpleCommand(input.command);
  const identityCwd = input.cwd ?? input.workspace_cwd ?? '/';
  const fileHashes: Record<string, string> = {};
  const hashFile = (p: string): void => {
    const hash = sha256FileContent(p);
    if (hash !== null) {
      fileHashes[p] = hash;
    }
  };
  const envOverrides: Record<string, string> = input.env ?? {};
  const cwdResolved = normalizeCwd({ cwd: input.cwd ?? undefined, workspace_root: input.workspace_cwd ?? '/' });
  if (parsed !== undefined) {
    const matched = matchAllowlist(parsed, input.allowlist);
    if (matched !== undefined) {
      hashFile(matched.argv0_resolved);
      for (const operand of operandIdentities(parsed, identityCwd)) {
        hashFile(operand);
      }
      return {
        kind: 'simple',
        argv: matched.argv,
        argv0_resolved: matched.argv0_resolved,
        raw_command: input.command,
        cwd_resolved: cwdResolved,
        env_overrides: envOverrides,
        file_hashes: fileHashes,
      };
    }
    // Hash the executed operand for simple non-allowlisted commands too.
    // These go to Tier 3, and the content binding must apply to all Tier 3 forms.
    const simpleOperand = extractExecutedFileOperand({ argv: parsed.argv });
    if (simpleOperand !== undefined) {
      const simpleIdentity = canonicalFileIdentity({ p: simpleOperand, cwd: identityCwd });
      if (simpleIdentity !== null) {
        hashFile(simpleIdentity);
      }
    }
    // Recurse into -c style inline code: `sh -c 'sh /ws/payload.sh'` hides
    // the inner script from extractExecutedFileOperand (which bails on -c).
    // An unbound inner script is a post-approval rewrite waiting to happen.
    hashInlineCodeOperands({ argv: parsed.argv, cwd: identityCwd, hashFile, depth: 0 });
    return {
      kind: 'simple',
      argv: parsed.argv,
      argv0_resolved: null,
      raw_command: input.command,
      cwd_resolved: cwdResolved,
      env_overrides: envOverrides,
      file_hashes: fileHashes,
    };
  }
  return {
    kind: 'compound',
    argv: splitWordsLenient(input.command),
    argv0_resolved: null,
    raw_command: input.command,
    cwd_resolved: cwdResolved,
    env_overrides: envOverrides,
    file_hashes: (() => {
      // Bind content hashes for compound commands too: for each segment,
      // extract the executed file operand and hash it, so a script rewritten
      // between approval and dispatch is detected at re-verification.
      // Also hash every file-like token in the raw command: nested constructs
      // like $(), backticks, or <() can hide executed scripts from the
      // segment parser, and an unbound script is a post-approval rewrite
      // waiting to happen.
      const hashes: Record<string, string> = {};
      const hashSegFile = (p: string): void => {
        const hash = sha256FileContent(p);
        if (hash !== null) {
          hashes[p] = hash;
        }
      };
      for (const segment of splitCompoundSegments(input.command)) {
        const segParsed = parseSimpleCommand(segment);
        const argv = segParsed !== undefined ? segParsed.argv : splitWordsLenient(segment);
        const operand = extractExecutedFileOperand({ argv });
        if (operand !== undefined) {
          const identity = canonicalFileIdentity({ p: operand, cwd: identityCwd });
          if (identity !== null) {
            hashSegFile(identity);
          }
        }
        // Recurse into -c inline code within compound segments too.
        hashInlineCodeOperands({ argv, cwd: identityCwd, hashFile: hashSegFile, depth: 0 });
      }
      for (const token of splitWordsLenient(input.command)) {
        if (token.startsWith('-')) {
          continue;
        }
        // Strip shell metacharacters that splitWordsLenient leaves attached:
        // $(...), `...`, <(...), trailing ), ;, &, |, etc.
        const cleaned = token.replace(/^[$`<(]+/, '').replace(/[)>;|&`]+$/, '');
        if (cleaned.length === 0) {
          continue;
        }
        const identity = canonicalFileIdentity({ p: cleaned, cwd: identityCwd });
        if (identity !== null) {
          hashSegFile(identity);
        }
      }
      return hashes;
    })(),
  };
}

export function shellBindingFromForm(form: CanonicalShellForm): ShellApprovalBinding {
  return {
    commands: [{ argv: [...form.argv], argv0_resolved: form.argv0_resolved }],
    redirections: [],
    cwd_resolved: form.cwd_resolved,
    env_overrides: form.env_overrides,
    file_hashes: form.file_hashes,
  };
}

function mintShellToken(input: {
  services: SentinelServices;
  tool_name: string;
  form: CanonicalShellForm;
}): { token_id: string; binding: ShellApprovalBinding } {
  const binding = shellBindingFromForm(input.form);
  const token = input.services.token_store.mint({
    action_id: actionIdFor({ tool_name: input.tool_name, canonical_params: input.form }),
    canonical_params: input.form,
    shell: binding,
  });
  return { token_id: token.token_id, binding };
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

async function classifyExecShell(action: SentinelAction, ctx: ClassifyContext): Promise<TierDecision> {
  const { services } = ctx;
  const command = stringParam(action.canonical_params, 'command') ?? '';
  const cwd = stringParam(action.canonical_params, 'cwd');
  const env = envOverrides(action.canonical_params);
  const offline = await services.isOffline({ tenant_id: ctx.tenant_id, created_by: ctx.created_by });

  // Agent-controlled env vars (e.g. LD_PRELOAD, PYTHONPATH, NODE_OPTIONS)
  // can inject code into allowlisted commands: escalate for approval.
  if (env !== null && Object.keys(env).length > 0) {
    return tier3Decision({
      card: {
        plain_what: `Run \`${command}\` with custom environment variables.`,
        plain_why: plainWhy(ctx.agent_intent),
        cannot_be_undone: 'Environment variables like LD_PRELOAD can inject code into the command.',
        why_asked_again: null,
        destination: null,
        recipient: null,
        amount: null,
        parsed_command: command,
      },
      reason: 'env_overrides_present',
      reason_detail: 'Custom environment variables require approval.',
      sensitive_read: false,
    });
  }

  // Offline: only the explicit offline subset of the allowlist may run.
  if (offline) {
    const parsed = parseSimpleCommand(command);
    const matched = parsed !== undefined ? matchAllowlist(parsed, services.shell_allowlist) : undefined;
    const commandName = parsed?.argv[0];
    if (
      parsed === undefined ||
      matched === undefined ||
      commandName === undefined ||
      !OFFLINE_SHELL_COMMANDS.includes(commandName)
    ) {
      return autoDenyDecision({
        reason: 'offline_mode',
        reason_detail: 'This shell command is not in the offline subset.',
        sensitive_read: false,
      });
    }
    const identityCwd = resolveIdentityCwd(ctx, cwd);
    const decision = tier2Decision({
      kind: 'shell',
      files: operandIdentities(parsed, identityCwd),
      reason: 'shell_allowlist_offline',
      reason_detail: `Offline: ran allowlisted command \`${commandName}\`.`,
      sensitive_read: sensitiveReadHit(action.canonical_params),
    });
    return applyAlwaysAsk({ decision, kind: 'shell', ctx, action });
  }

  // Write-then-execute check BEFORE allowlist matching. Scan every segment
  // of a compound command (`;`, `&&`, `||`, `|`): a tracked script hidden
  // behind a separator (e.g. `echo ok; sh payload.sh`) must not bypass this.
  const parsed = parseSimpleCommand(command);
  const segments = splitCompoundSegments(command);
  for (const segment of segments) {
    const segParsed = parseSimpleCommand(segment);
    const argvForHash = segParsed !== undefined ? segParsed.argv : splitWordsLenient(segment);
    const executedOperand = extractExecutedFileOperand({ argv: argvForHash });
    if (executedOperand === undefined) {
      continue;
    }
    const identityCwd = resolveIdentityCwd(ctx, cwd);
    const identity = canonicalFileIdentity({ p: executedOperand, cwd: identityCwd });
    if (identity === null) {
      return tier3Decision({
        card: {
          plain_what: `Execute \`${basenameOf(executedOperand)}\`, which the server cannot resolve to a workspace file.`,
          plain_why: plainWhy(ctx.agent_intent),
          cannot_be_undone: 'The executed file could do anything once it runs.',
          why_asked_again: null,
          destination: null,
          recipient: null,
          amount: null,
          parsed_command: command,
        },
        reason: 'tracked_check_unresolvable',
        reason_detail: 'The executed operand could not be resolved; failing closed.',
        sensitive_read: false,
        approval_token_id: mintPlainToken({ services, tool_name: action.tool_name, params: action.canonical_params }),
      });
    }
    if (services.tracked_store.isTracked({ scope: workspaceScope(ctx), file_identity: identity })) {
      const contentHash = sha256FileContent(identity);
      const argvHash = hashArgv(argvForHash);
      const grantParams =
        contentHash === null
          ? null
          : { file_identity: identity, content_hash: contentHash, argv_hash: argvHash, argv: argvForHash };
      const granted =
        grantParams !== null &&
        services.tracked_store.hasGrant({
          conversation_id: ctx.conversation_id,
          file_identity: identity,
          content_hash: grantParams.content_hash,
          argv_hash: grantParams.argv_hash,
        });
      if (!granted) {
        const binding: TrackedExecutionBinding = {
          file_identity: identity,
          content_hash: contentHash ?? '',
          argv_hash: argvHash,
        };
        const token =
          grantParams === null
            ? mintPlainToken({ services, tool_name: action.tool_name, params: action.canonical_params })
            : services.token_store.mint({
                action_id: actionIdFor({ tool_name: action.tool_name, canonical_params: grantParams }),
                canonical_params: grantParams,
              }).token_id;
        return tier3Decision({
          card: {
            plain_what: `Execute \`${basenameOf(identity)}\`, a script the agent wrote earlier.`,
            plain_why: plainWhy(ctx.agent_intent),
            cannot_be_undone: 'The script runs with full shell access once approved.',
            why_asked_again: null,
            destination: null,
            recipient: null,
            amount: null,
            parsed_command: command,
          },
          reason: 'tracked_executable_unapproved',
          reason_detail: 'No matching approval grant for this (content, argv) pair.',
          sensitive_read: false,
          approval_binding: binding,
          approval_token_id: token,
        });
      }
      // Approved tracked execution falls through to the normal allowlist path.
    }
  }

  // Allowlist matching.
  if (parsed !== undefined) {
    const matched = matchAllowlist(parsed, services.shell_allowlist);
    if (matched !== undefined) {
      const identityCwd = resolveIdentityCwd(ctx, cwd);
      // The cwd and every file operand must resolve inside the workspace.
      // An agent-controlled cwd or a symlink escape must not get Tier 2.
      const workspaceRoot = ctx.workspace_cwd;
      if (workspaceRoot !== null) {
        const cwdInside = isInsideWorkspace({ p: identityCwd, cwd: '/', workspace_root: workspaceRoot });
        if (!cwdInside) {
          return tier3Decision({
            card: {
              plain_what: `Run \`${command}\` from outside the workspace.`,
              plain_why: plainWhy(ctx.agent_intent),
              cannot_be_undone: 'Running outside the workspace can access system files.',
              why_asked_again: null,
              destination: null,
              recipient: null,
              amount: null,
              parsed_command: command,
            },
            reason: 'cwd_outside_workspace',
            reason_detail: 'The working directory is outside the workspace.',
            sensitive_read: false,
          });
        }
        if (!shellOperandsInsideWorkspace({ parsed, cwd: identityCwd, workspace_root: workspaceRoot })) {
          return tier3Decision({
            card: {
              plain_what: `Access a file outside the workspace with \`${command}\`.`,
              plain_why: plainWhy(ctx.agent_intent),
              cannot_be_undone: 'This file is outside the workspace boundary.',
              why_asked_again: null,
              destination: null,
              recipient: null,
              amount: null,
              parsed_command: command,
            },
            reason: 'file_outside_workspace',
            reason_detail: 'A file operand resolves outside the workspace.',
            sensitive_read: false,
          });
        }
      }
      const decision = tier2Decision({
        kind: 'shell',
        files: operandIdentities(parsed, identityCwd),
        reason: 'shell_allowlist',
        reason_detail: `Ran allowlisted command \`${parsed.argv[0] ?? command}\`.`,
        sensitive_read: sensitiveReadHit(action.canonical_params),
      });
      return applyAlwaysAsk({ decision, kind: 'shell', ctx, action });
    }
  }

  // Not allowlisted: Tier 3 with the full parsed binding.
  const form = canonicalShellForm({
    command,
    cwd,
    env,
    allowlist: services.shell_allowlist,
    workspace_cwd: ctx.workspace_cwd,
  });
  const { token_id, binding } = mintShellToken({ services, tool_name: action.tool_name, form });
  return tier3Decision({
    card: {
      plain_what:
        form.kind === 'compound'
          ? 'Run a compound shell command (pipes, chaining, or redirects).'
          : `Run \`${form.argv[0] ?? command}\` with arguments the safe list does not allow.`,
      plain_why: plainWhy(ctx.agent_intent),
      cannot_be_undone: 'Shell commands can change or delete files once they run.',
      why_asked_again: null,
      destination: null,
      recipient: null,
      amount: null,
      parsed_command: form.raw_command,
    },
    reason: 'shell_not_allowlisted',
    reason_detail: 'The command is not on the server-side safe list.',
    sensitive_read: sensitiveReadHit(action.canonical_params),
    shell_binding: binding,
    approval_token_id: token_id,
  });
}

function mintPlainToken(input: {
  services: SentinelServices;
  tool_name: string;
  params: unknown;
}): string {
  return input.services.token_store.mint({
    action_id: actionIdFor({ tool_name: input.tool_name, canonical_params: input.params }),
    canonical_params: input.params,
  }).token_id;
}

async function classifySandboxWrite(action: SentinelAction, ctx: ClassifyContext): Promise<TierDecision> {
  const target = stringParam(action.canonical_params, 'path') ?? stringParam(action.canonical_params, 'target');
  const identityCwd = resolveIdentityCwd(ctx, null);
  // Fail closed on null target or missing workspace: treat as outside workspace.
  if (target === null || ctx.workspace_cwd === null) {
    return tier3Decision({
      card: {
        plain_what: 'Write a file outside the workspace.',
        plain_why: plainWhy(ctx.agent_intent),
        cannot_be_undone: 'The file will exist outside the workspace once written.',
        why_asked_again: null,
        destination: null,
        recipient: null,
        amount: null,
        parsed_command: null,
      },
      reason: 'write_outside_workspace',
      reason_detail: 'Write target is null or workspace is unknown.',
      sensitive_read: false,
      approval_token_id: mintPlainToken({
        services: ctx.services,
        tool_name: action.tool_name,
        params: action.canonical_params,
      }),
    });
  }
  // Resolve the write target via its parent directory: the target itself may
  // not exist yet, and resolving it directly would misread every new-file
  // write as outside the workspace.
  const inside = (() => {
    const identity = canonicalWriteTarget({ p: target, cwd: identityCwd });
    if (identity === null) { return false; }
    try {
      const root = realpathSync(ctx.workspace_cwd);
      return identity === root || identity.startsWith(`${root}${path.sep}`);
    } catch {
      return false;
    }
  })();
  if (!inside) {
    return tier3Decision({
      card: {
        plain_what: `Write a file outside the workspace at \`${target}\`.`,
        plain_why: plainWhy(ctx.agent_intent),
        cannot_be_undone: 'The file will exist outside the workspace once written.',
        why_asked_again: null,
        destination: null,
        recipient: null,
        amount: null,
        parsed_command: null,
      },
      reason: 'write_outside_workspace',
      reason_detail: 'Write targets outside the workspace are never Tier 2.',
      sensitive_read: false,
      approval_token_id: mintPlainToken({
        services: ctx.services,
        tool_name: action.tool_name,
        params: action.canonical_params,
      }),
    });
  }
  // `target` is `string` (not null) here: the early return above guarantees it.
  // `inside` is true, so the path is in the workspace.
  const identity = canonicalWriteTarget({ p: target, cwd: identityCwd });
  const decision = tier2Decision({
    kind: 'file_write',
    files: identity === null ? [] : [identity],
    reason: 'sandbox_write',
    reason_detail: `Sandbox file write to \`${target}\`.`,
    sensitive_read: isSensitivePath(target),
  });
  return applyAlwaysAsk({ decision, kind: 'file_write', ctx, action });
}

function classifyRunnerTool(action: SentinelAction, ctx: ClassifyContext): TierDecision {
  const workflowParam = action.canonical_params['workflow'];
  const workflowName = typeof workflowParam === 'string' ? workflowParam : 'unknown';
  // Runner workflows execute agent-controlled package.json script targets.
  // Tier 2 is non-blocking, which would allow code execution without
  // approval: escalate to Tier 3.
  return tier3Decision({
    card: {
      plain_what: `Run the \`${workflowName}\` workflow (executes package.json scripts).`,
      plain_why: plainWhy(ctx.agent_intent),
      cannot_be_undone: 'The workflow runs scripts that the agent can modify.',
      why_asked_again: null,
      destination: null,
      recipient: null,
      amount: null,
      parsed_command: `pnpm ${workflowName}`,
    },
    reason: 'runner_workflow',
    reason_detail: `Run the \`${workflowName}\` workflow requires approval.`,
    sensitive_read: false,
  });
}

/** Tier 2 decision escalated to Tier 3 by the user's "always ask me" toggle. */
async function applyAlwaysAsk(input: {
  decision: TierDecision;
  kind: Tier2ActionKind;
  ctx: ClassifyContext;
  action: SentinelAction;
}): Promise<TierDecision> {
  const { decision, kind, ctx, action } = input;
  if (decision.tier !== 2) {
    return decision;
  }
  const alwaysAsk = await ctx.services.alwaysAsk({ tenant_id: ctx.tenant_id, created_by: ctx.created_by });
  if (!alwaysAsk.has(kind)) {
    return decision;
  }
  return tier3Decision({
    card: {
      plain_what: decision.reason_detail ?? 'Run an action you asked to always approve.',
      plain_why: plainWhy(ctx.agent_intent),
      cannot_be_undone: 'You turned on "always ask me" for this kind of action.',
      why_asked_again: null,
      destination: null,
      recipient: null,
      amount: null,
      parsed_command: null,
    },
    reason: 'always_ask_toggle',
    reason_detail: `Escalated by the always-ask toggle for ${kind}.`,
    sensitive_read: decision.sensitive_read,
    escalated: true,
    tier2_kind: kind,
    tier2_files: decision.tier2_files,
    approval_token_id: mintPlainToken({ services: ctx.services, tool_name: action.tool_name, params: action.canonical_params }),
  });
}

function externalServiceWhat(input: {
  tool_name: string;
  destination: string | null;
  recipient: string | null;
  amount: string | null;
}): string {
  const name = input.tool_name.toLowerCase();
  const where = input.recipient ?? input.destination ?? 'an external destination';
  if (name.includes('email') || name.includes('mail')) {
    return `Send an email to ${where}.`;
  }
  if (name.includes('sms') || name.includes('message') || name.includes('notify')) {
    return `Send a message to ${where}.`;
  }
  if (name.includes('post') || name.includes('publish') || name.includes('tweet')) {
    return `Publish a post${input.destination === null ? '' : ` to ${input.destination}`}.`;
  }
  if (name.includes('share') || name.includes('webhook')) {
    return `Share data with ${where}.`;
  }
  if (
    name.includes('pay') ||
    name.includes('spend') ||
    name.includes('charge') ||
    name.includes('transfer') ||
    name.includes('invoice')
  ) {
    return `Spend ${input.amount ?? 'money'}${input.destination === null ? '' : ` via ${input.destination}`}.`;
  }
  return `Perform an external action (${input.tool_name}) affecting ${where}.`;
}

const DESTRUCTIVE_FRAGMENTS = ['delete', 'remove', 'uninstall', 'drop', 'destroy', 'erase'];
const INSTALL_FRAGMENTS = ['install'];

async function classifyGenericTool(action: SentinelAction, ctx: ClassifyContext): Promise<TierDecision> {
  const { services } = ctx;
  const name = action.tool_name.toLowerCase();

  // Offline: network-required tools are filtered from the list; a stale call
  // that slips through is auto-denied here.
  const offline = await services.isOffline({ tenant_id: ctx.tenant_id, created_by: ctx.created_by });
  const extraction = extractCardFields({ tool_name: action.tool_name, canonical_params: action.canonical_params });
  if (offline) {
    if (extraction.external_service) {
      return autoDenyDecision({
        reason: 'offline_mode',
        reason_detail: 'External-service actions are disabled while offline.',
        sensitive_read: false,
      });
    }
    if (
      requiresNetwork({ tool_name: action.tool_name, provenance: provenanceForToolType(action.tool_type) })
    ) {
      return autoDenyDecision({
        reason: 'offline_mode',
        reason_detail: 'This tool needs network access, which is disabled while offline.',
        sensitive_read: false,
      });
    }
  }

  // Extractor fallback: unverifiable destination on an external-service action.
  if (extraction.destination_unverifiable) {
    return autoDenyDecision({
      reason: 'destination_unverifiable',
      reason_detail: 'External-service action with no verifiable destination; never carded.',
      sensitive_read: false,
    });
  }

  // Web search: the web provider's tool is read-only and safe to allow
  // without approval. Offline mode is handled above.
  // Scoped by platform-owned provenance, not by name alone: the web
  // provider's tool carries mcp_server_id UNKNOWN_TOOL_NAME ('unknown')
  // because it is not from any configured MCP server. A named MCP server
  // squatting the name 'web_search' carries its real server id and falls
  // through to fail-closed Tier 3 below.
  if (name === 'web_search' && action.mcp_server_id === UNKNOWN_TOOL_NAME) {
    return tier1Decision({
      reason: 'web_search',
      reason_detail: 'Web search (read-only).',
      sensitive_read: false,
    });
  }

  // call_tool dispatcher: classify by the inner tool being invoked. The
  // dispatcher carries the inner tool name in the `tool_name` param.
  // Scoped by platform-owned provenance: only the platform DeferredTool
  // (mcp_server_id 'deferred-tools', see DEFERRED_TOOLS_SERVER_ID in
  // runtime/DeferredTool.ts) may dispatch. A named MCP server squatting the
  // name 'call_tool' carries its real server id and falls through to
  // fail-closed Tier 3 below. String literal avoids a classifier ->
  // DeferredTool -> LocalToolMCP -> ToolSet -> classifier import cycle.
  if (
    name === 'call_tool' &&
    action.mcp_server_id === 'deferred-tools' &&
    action.mcp_hints.destructive_hint !== true
  ) {
    const innerParam = action.canonical_params['tool_name'];
    const inner = typeof innerParam === 'string' ? innerParam.toLowerCase() : '';
    if (inner === 'web_search' || inner === 'web_fetch') {
      return tier1Decision({
        reason: 'call_tool',
        reason_detail: `Dispatch to ${inner} (read-only).`,
        sensitive_read: false,
      });
    }
  }

  // MCP hints: destructive or open-world escalate to Tier 3, never lower.
  const destructiveHint = action.mcp_hints.destructive_hint === true;
  const openWorldHint = action.mcp_hints.open_world_hint === true;
  const readOnlyHint = action.mcp_hints.read_only_hint === true;
  if (destructiveHint || (openWorldHint && !readOnlyHint)) {
    const { fields } = extraction;
    return tier3Decision({
      card: {
        plain_what: extraction.external_service
          ? externalServiceWhat({
              tool_name: action.tool_name,
              destination: fields.destination,
              recipient: fields.recipient,
              amount: fields.amount,
            })
          : `Run \`${action.tool_name}\`, flagged as ${destructiveHint ? 'destructive' : 'reaching outside this machine'}.`,
        plain_why: plainWhy(ctx.agent_intent),
        cannot_be_undone: destructiveHint
          ? 'The action is flagged as destructive; its effects may not be reversible.'
          : 'Once data leaves this machine it cannot be taken back.',
        why_asked_again: null,
        destination: fields.destination,
        recipient: fields.recipient,
        amount: fields.amount,
        parsed_command: null,
      },
      reason: destructiveHint ? 'mcp_destructive_hint' : 'mcp_open_world_hint',
      reason_detail: 'MCP annotations flagged the tool; hints escalate only.',
      sensitive_read: sensitiveReadHit(action.canonical_params),
      escalated: true,
      approval_token_id: mintPlainToken({ services, tool_name: action.tool_name, params: action.canonical_params }),
    });
  }

  // Name-based Tier 3 classes: external-service (non-fallback), destructive, install.
  const isDestructive = DESTRUCTIVE_FRAGMENTS.some(fragment => name.includes(fragment));
  const isInstall = INSTALL_FRAGMENTS.some(fragment => name.includes(fragment));
  if (extraction.external_service || isDestructive || isInstall) {
    const { fields } = extraction;
    const what = extraction.external_service
      ? externalServiceWhat({
          tool_name: action.tool_name,
          destination: fields.destination,
          recipient: fields.recipient,
          amount: fields.amount,
        })
      : isInstall
        ? 'Install software or dependencies.'
        : `Delete or remove ${fields.destination ?? fields.recipient ?? 'data'}.`;
    return tier3Decision({
      card: {
        plain_what: what,
        plain_why: plainWhy(ctx.agent_intent),
        cannot_be_undone: isDestructive ? 'Deleted data cannot be recovered.' : 'Once this runs it cannot be taken back.',
        why_asked_again: null,
        destination: fields.destination,
        recipient: fields.recipient,
        amount: fields.amount,
        parsed_command: null,
      },
      reason: extraction.external_service ? 'external_service' : isInstall ? 'install_action' : 'destructive_action',
      reason_detail: 'Name-based Tier 3 class.',
      sensitive_read: sensitiveReadHit(action.canonical_params),
      approval_token_id: mintPlainToken({ services, tool_name: action.tool_name, params: action.canonical_params }),
    });
  }

  // Local read-only first-party tools: Tier 1.
  if (action.tool_type === 'truefoundry-system' && readOnlyHint && !openWorldHint) {
    return tier1Decision({
      reason: 'local_read_only',
      reason_detail: `Local read-only tool \`${action.tool_name}\`.`,
      sensitive_read: sensitiveReadHit(action.canonical_params),
    });
  }

  // Fail closed: anything unrecognized is Tier 3 with a card.
  return tier3Decision({
    card: {
      plain_what: `Run \`${action.tool_name}\`, which the classifier does not recognize.`,
      plain_why: plainWhy(ctx.agent_intent),
      cannot_be_undone: 'Unrecognized actions are treated as potentially irreversible.',
      why_asked_again: null,
      destination: null,
      recipient: null,
      amount: null,
      parsed_command: null,
    },
    reason: 'unrecognized_tool',
    reason_detail: 'Fail-closed: unrecognized tools require approval.',
    sensitive_read: sensitiveReadHit(action.canonical_params),
    approval_token_id: mintPlainToken({ services, tool_name: action.tool_name, params: action.canonical_params }),
  });
}

/**
 * The single authoritative tier classifier. Fail-closed on anything
 * unrecognized; MCP hints escalate-only.
 */
export async function classifyTier(action: SentinelAction, ctx: ClassifyContext): Promise<TierDecision> {
  const name = action.tool_name;

  // Only the verified system exec tool gets the allowlist path. An MCP tool
  // named 'exec' must not be downgraded to Tier 2; it falls through to the
  // fail-closed Tier 3 default below.
  if (action.tool_type === 'truefoundry-system') {
    if (name === 'exec') {
      return classifyExecShell(action, ctx);
    }
    if (name === 'write_file' || name === 'apply_patch' || name === 'replace_text') {
      return classifySandboxWrite(action, ctx);
    }
    if (
      name === 'run_registered_command' ||
      (name === 'run_workflow' && isRunnerWorkflow(action.canonical_params['workflow']))
    ) {
      return classifyRunnerTool(action, ctx);
    }
    if (name === 'run_code' || name === 'submit_implementation_plan') {
      return tier3Decision({
        card: {
          plain_what:
            name === 'run_code' ? 'Run code the agent wrote in the sandbox.' : 'Submit an implementation plan for review.',
          plain_why: plainWhy(ctx.agent_intent),
          cannot_be_undone: 'Execution cannot be taken back once it runs.',
          why_asked_again: null,
          destination: null,
          recipient: null,
          amount: null,
          parsed_command: null,
        },
        reason: name === 'run_code' ? 'arbitrary_code_execution' : 'plan_submission',
        reason_detail: 'Always Tier 3 by policy.',
        sensitive_read: false,
        approval_token_id: mintPlainToken({
          services: ctx.services,
          tool_name: action.tool_name,
          params: action.canonical_params,
        }),
      });
    }
  }

  return classifyGenericTool(action, ctx);
}

/**
 * Classify one host tool call and audit the decision. Canonical owner of the
 * classify-then-audit sequence: ToolSet, Sandbox, and the AgentThread
 * builtin choke point all go through here so the logic lives in one place.
 */
export async function classifyHostToolCall(input: {
  sentinel: SentinelHostContext;
  repository_id: string | null;
  workspace_cwd: string | null;
  action: SentinelAction;
}): Promise<TierDecision> {
  const ctx = classifyContextFor({
    host: input.sentinel,
    repository_id: input.repository_id,
    workspace_cwd: input.workspace_cwd,
  });
  const decision = await classifyTier(input.action, ctx);
  await recordClassificationAudit({
    services: ctx.services,
    identity: {
      tenant_id: ctx.tenant_id,
      created_by: ctx.created_by,
      conversation_id: ctx.conversation_id,
      repository_id: ctx.repository_id,
      workspace_cwd: ctx.workspace_cwd,
      agent_intent: ctx.agent_intent,
    },
    tool_name: input.action.tool_name,
    decision,
  });
  return decision;
}

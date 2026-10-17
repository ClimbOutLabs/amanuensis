/**
 * Sentinel tier classifier: the single authoritative `classifyTier(action)`.
 *
 * Full action matrix, fail-closed on anything unrecognized. Ordering per the
 * spec: offline auto-deny first; write-then-execute check before allowlist
 * matching; allowlist before Tier 3; extractor fallback for external-service
 * actions. A connector tool's own MCP hints escalate it but never lower it by
 * themselves. Two things let a read-only, explicitly closed-world connector
 * tool skip its card: the host's first-party trust in the connector, and the
 * user's own standing grant for the tool. Every escalation is checked before
 * either. Returns a TierDecision with stable reason codes, the approval card,
 * the Tier 2 kind, and the tracked-execution approval binding.
 */
import { realpathSync } from 'fs';
import path from 'path';
import type { MapsHosts } from '../llm/LLMTypes';
import {
  actionIdFor,
  approvalTokenExpiry,
  normalizeCwd,
  toJsonSafeParams,
  type ApprovalTokenScope,
  type ConnectorBinding,
  type ShellApprovalBinding,
} from './approvalTokens';
import { recordClassificationAudit } from './audit';
import { FIRST_PARTY_TOOL_REASON } from './connectorTrust';
import {
  classifyContextFor,
  type SentinelCallIdentity,
  type SentinelHostContext,
  type SentinelServices,
} from './context';
import {
  escapeDisplayText,
  extractCardFields,
  renderOutboundArguments,
  type ExtractionResult,
} from './extractorRegistry';
import { isMapsToolName, RENDER_ROUTE_TOOL_NAME } from './mapsToolNames';
import { provenanceForToolType, requiresNetwork } from './networkRequirements';
import {
  checkOutboundStrings,
  collectOutboundStrings,
  describeOutboundRule,
  type OutboundStrings,
} from './outboundGuard';
import { isRunnerWorkflow } from './runner';
import {
  hashArgv,
  matchAllowlist,
  OFFLINE_SHELL_COMMANDS,
  parseSimpleCommand,
  type ParsedSimpleCommand,
  type ShellAllowlistConfig,
} from './shellAllowlist';
import {
  autoDenyDecision,
  tier1Decision,
  tier2Decision,
  tier3Decision,
  type Tier2ActionKind,
  type Tier3Card,
  type TierDecision,
  type TrackedExecutionBinding,
} from './tier';
import { TOOL_GRANT_REASON } from './toolGrants';
import {
  canonicalFileIdentity,
  canonicalWriteTarget,
  contentDigest,
  extractExecutedFileOperand,
  isInsideWorkspace,
  isUnderRoot,
  lexicalPath,
  sha256FileContent,
  splitCompoundSegments,
  splitWordsLenient,
  writeTargetTouchesGitControl,
  writeTargetTouchesSandboxTools,
  type FileDigest,
  type PathResolution,
  type TrackedExecutableScope,
} from './trackedExecutables';
import {
  SEARCH_SILENT_REASON,
  SILENT_SEARCH_LIMIT,
  unreturnedUrls,
  type SearchAskReason,
  type WebSearchTurnState,
} from './webSearch';

export interface SentinelAction {
  /** Original tool name (sandbox name or mcp server tool name). */
  tool_name: string;
  /** The exact arguments the server will act on. */
  canonical_params: Record<string, unknown>;
  /** 'truefoundry-system' for sandbox and other built-in tools, 'mcp' for MCP tools. */
  tool_type: 'truefoundry-system' | 'mcp';
  /** Sandbox command effect when the action ran through the sandbox effect layer. */
  sandbox_effect?: string | undefined;
  /** Connector serving an MCP tool; keys the user's standing tool grants. */
  mcp_server_name?: string | undefined;
  /** Connector's server id; with `mcp_server_host` it is bound into the approval token. */
  mcp_server_id?: string | undefined;
  /** Host of the connector's configured server URL, for the approval card. Never derived from tool arguments. */
  mcp_server_host?: string | undefined;
  /** The host provisioned this connector itself. Never derived from tool metadata or client input. */
  mcp_first_party?: boolean | undefined;
  /** The user designated this connector as their search provider. Set by the host from the connector record only. */
  mcp_search_provider?: boolean | undefined;
  /** The host's own list for the designated provider names this tool as a search tool. Never from tool metadata. */
  mcp_search_tool?: boolean | undefined;
  mcp_hints: {
    read_only_hint?: boolean | undefined;
    destructive_hint?: boolean | undefined;
    open_world_hint?: boolean | undefined;
  };
  /**
   * Configured maps upstream hosts for the approval card destination. Set by the
   * server-owned maps tool from server config, never from model params.
   */
  maps_hosts?: MapsHosts | undefined;
}

export interface ClassifyContext extends SentinelCallIdentity {
  services: SentinelServices;
  /** Host state for the turn's silent web searches. */
  web_search: WebSearchTurnState;
  /** How this call's paths are resolved; set by the sandbox provider. Absent means the server's own filesystem. */
  path_resolution?: PathResolution | undefined;
  /** Reads file digests from a remote sandbox, so approvals can bind to file content there too. */
  file_digest?: FileDigest | undefined;
}

/** Longest place string the approval card shows; the tool schemas cap the same fields at this length. */
const MAPS_CARD_PLACE_MAX_CHARS = 128;

/**
 * One call parameter as the card shows it: quoted with escapes so a crafted name cannot close the
 * quote and read as part of the sentence, truncated to the schema cap, and a visible placeholder for
 * a value that is not text (the tool rejects it after approval, but the card must not lie).
 */
function mapsCardLabel(value: unknown): string {
  if (typeof value !== 'string') {
    return '(not text)';
  }
  const chars = Array.from(value);
  const shown =
    chars.length > MAPS_CARD_PLACE_MAX_CHARS ? `${chars.slice(0, MAPS_CARD_PLACE_MAX_CHARS - 1).join('')}…` : value;
  return JSON.stringify(shown);
}

/**
 * Single predicate owning the maps approval policy. Both maps tools are Tier 3
 * for now; when the policy changes (e.g. approved providers run without asking),
 * only this predicate changes.
 */
export function isMapsToolAlwaysTier3(tool_name: string): boolean {
  return isMapsToolName(tool_name);
}

/** Host part of a URL for card display; falls back to the raw value. */
function mapsHost(url: string | undefined): string {
  if (url === undefined || url === '') {
    return 'the configured maps host';
  }
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * The configured maps hosts as one string, from server config only. It is both the card's
 * "sends to" line and the connector host the approval token is bound to, so an approval stops
 * working once any maps upstream points elsewhere.
 */
export function mapsDestinationHosts(hosts: MapsHosts): string {
  const parts = [mapsHost(hosts.geocoder), mapsHost(hosts.router), mapsHost(hosts.tile)];
  return [...new Set(parts)].join(', ');
}

/** Card plain_what naming the quoted place strings and the configured hosts. */
function mapsPlainWhat(action: SentinelAction): string {
  const params = action.canonical_params;
  const hosts = action.maps_hosts;
  const geocoder = mapsHost(hosts?.geocoder);
  const router = mapsHost(hosts?.router);
  const tile = mapsHost(hosts?.tile);
  if (action.tool_name === RENDER_ROUTE_TOOL_NAME) {
    return (
      `Send ${mapsCardLabel(params['from_place'])} and ${mapsCardLabel(params['to_place'])} to ${geocoder}, ` +
      `ask ${router} for a driving route between them, then load map tiles for that area from ${tile}.`
    );
  }
  const placeName = mapsCardLabel(params['place_name']);
  if (params['poi'] !== undefined && params['poi'] !== '') {
    const poi = mapsCardLabel(params['poi']);
    return (
      `Send ${placeName} and ${poi} to ${geocoder} to find ${poi} near it, ` +
      `then load map tiles for that area from ${tile}.`
    );
  }
  return `Send ${placeName} to ${geocoder} to find it, then load map tiles for that area from ${tile}.`;
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

/** Null when the agent gave no reason, so the card shows no line instead of an empty one. */
function plainWhy(agentIntent: string | null): string | null {
  if (agentIntent === null || agentIntent.trim() === '') {
    return null;
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
  if (ctx.path_resolution === 'remote' && cwd !== null && ctx.workspace_cwd !== null) {
    // A relative cwd means "below the workspace" there, as the sandbox itself reads it; one that cannot be read is outside.
    return lexicalPath({ p: cwd, cwd: ctx.workspace_cwd }) ?? '/';
  }
  return cwd ?? ctx.workspace_cwd ?? '/';
}

/** Canonical identities of the non-flag tokens of a parsed simple command. */
function operandIdentities(input: {
  parsed: ParsedSimpleCommand;
  cwd: string;
  resolution: PathResolution | undefined;
}): string[] {
  const out: string[] = [];
  for (const token of input.parsed.argv.slice(1)) {
    if (token.startsWith('-')) {
      continue;
    }
    const identity = canonicalFileIdentity({ p: token, cwd: input.cwd, resolution: input.resolution });
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
  resolution: PathResolution | undefined;
}): boolean {
  const { resolution } = input;
  let root: string | null;
  try {
    root =
      resolution === 'remote' ? lexicalPath({ p: input.workspace_root, cwd: '/' }) : realpathSync(input.workspace_root);
  } catch {
    return false;
  }
  if (root === null) {
    return false;
  }
  const separator = resolution === 'remote' ? '/' : path.sep;
  for (const token of input.parsed.argv.slice(1)) {
    if (token.startsWith('-')) {
      continue;
    }
    const identity =
      canonicalFileIdentity({ p: token, cwd: input.cwd, resolution }) ??
      canonicalWriteTarget({ p: token, cwd: input.cwd, resolution });
    if (identity === null) {
      return false;
    }
    if (!isUnderRoot({ identity, root, separator })) {
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
  resolution: PathResolution | undefined;
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
        const identity = canonicalFileIdentity({ p: operand, cwd: input.cwd, resolution: input.resolution });
        if (identity !== null) {
          input.hashFile(identity);
        }
      }
      // Recurse for nested -c (e.g. sh -c 'sh -c "sh /ws/x.sh"').
      hashInlineCodeOperands({
        argv: segArgv,
        cwd: input.cwd,
        hashFile: input.hashFile,
        depth: input.depth + 1,
        resolution: input.resolution,
      });
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
      const identity = canonicalFileIdentity({ p: cleaned, cwd: input.cwd, resolution: input.resolution });
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
  path_resolution?: PathResolution | undefined;
  /** Remote sandbox only: digests of the files the command names, fetched beforehand (see canonicalShellFormFor). */
  file_digests?: ReadonlyMap<string, string> | undefined;
  /** Remote sandbox only: receives the files whose digests the form would use. */
  collect_files?: Set<string> | undefined;
}): CanonicalShellForm {
  const resolution = input.path_resolution;
  const digestOf = (p: string): string | null => {
    if (resolution !== 'remote') {
      return sha256FileContent(p);
    }
    input.collect_files?.add(p);
    return input.file_digests?.get(p) ?? null;
  };
  const parsed = parseSimpleCommand(input.command);
  const identityCwd = input.cwd ?? input.workspace_cwd ?? '/';
  const fileHashes: Record<string, string> = {};
  const hashFile = (p: string): void => {
    const hash = digestOf(p);
    if (hash !== null) {
      fileHashes[p] = hash;
    }
  };
  const envOverrides: Record<string, string> = input.env ?? {};
  const cwdResolved = normalizeCwd({
    cwd: input.cwd ?? undefined,
    workspace_root: input.workspace_cwd ?? '/',
    resolution,
  });
  if (parsed !== undefined) {
    const matched = matchAllowlist(parsed, input.allowlist);
    if (matched !== undefined) {
      hashFile(matched.argv0_resolved);
      for (const operand of operandIdentities({ parsed, cwd: identityCwd, resolution })) {
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
      const simpleIdentity = canonicalFileIdentity({ p: simpleOperand, cwd: identityCwd, resolution });
      if (simpleIdentity !== null) {
        hashFile(simpleIdentity);
      }
    }
    // Recurse into -c style inline code: `sh -c 'sh /ws/payload.sh'` hides
    // the inner script from extractExecutedFileOperand (which bails on -c).
    // An unbound inner script is a post-approval rewrite waiting to happen.
    hashInlineCodeOperands({ argv: parsed.argv, cwd: identityCwd, hashFile, depth: 0, resolution });
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
        const hash = digestOf(p);
        if (hash !== null) {
          hashes[p] = hash;
        }
      };
      for (const segment of splitCompoundSegments(input.command)) {
        const segParsed = parseSimpleCommand(segment);
        const argv = segParsed !== undefined ? segParsed.argv : splitWordsLenient(segment);
        const operand = extractExecutedFileOperand({ argv });
        if (operand !== undefined) {
          const identity = canonicalFileIdentity({ p: operand, cwd: identityCwd, resolution });
          if (identity !== null) {
            hashSegFile(identity);
          }
        }
        // Recurse into -c inline code within compound segments too.
        hashInlineCodeOperands({ argv, cwd: identityCwd, hashFile: hashSegFile, depth: 0, resolution });
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
        const identity = canonicalFileIdentity({ p: cleaned, cwd: identityCwd, resolution });
        if (identity !== null) {
          hashSegFile(identity);
        }
      }
      return hashes;
    })(),
  };
}

const MAX_REMOTE_DIGESTS = 16;

/**
 * The canonical shell form. In a remote sandbox the files the command names are read through the sandbox
 * first, so the form binds to their content as it does on the server's own filesystem.
 */
export async function canonicalShellFormFor(
  input: Parameters<typeof canonicalShellForm>[0] & { file_digest?: FileDigest | undefined },
): Promise<CanonicalShellForm> {
  if (input.path_resolution !== 'remote' || input.file_digest === undefined) {
    return canonicalShellForm(input);
  }
  const wanted = new Set<string>();
  canonicalShellForm({ ...input, collect_files: wanted });
  const digests = new Map<string, string>();
  await Promise.all(
    [...wanted].slice(0, MAX_REMOTE_DIGESTS).map(async file => {
      const digest = await contentDigest({ identity: file, resolution: 'remote', digest: input.file_digest });
      if (digest !== null) {
        digests.set(file, digest);
      }
    }),
  );
  return canonicalShellForm({ ...input, file_digests: digests });
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

async function mintShellToken(input: { ctx: ClassifyContext; tool_name: string; form: CanonicalShellForm }): Promise<{
  token_id: string;
  binding: ShellApprovalBinding;
}> {
  const binding = shellBindingFromForm(input.form);
  const token = await input.ctx.services.token_store.mint({
    ...approvalTokenOwner(input.ctx),
    action_id: actionIdFor({ tool_name: input.tool_name, canonical_params: input.form }),
    canonical_params: input.form,
    shell: binding,
  });
  return { token_id: token.token_id, binding };
}

/** Scope and expiry every approval token is minted with; dispatch redeems under the same identity. */
function approvalTokenOwner(ctx: ClassifyContext): ApprovalTokenScope & { expires_at: string } {
  return { tenant_id: ctx.tenant_id, created_by: ctx.created_by, expires_at: approvalTokenExpiry() };
}

/** Token and parsed binding that let dispatch re-verify an approved shell command. */
async function mintShellApproval(input: {
  ctx: ClassifyContext;
  action: SentinelAction;
  command: string;
  cwd: string | null;
  env: Record<string, string> | null;
}): Promise<{ approval_token_id: string; shell_binding: ShellApprovalBinding }> {
  const { ctx, action } = input;
  const form = await canonicalShellFormFor({
    command: input.command,
    cwd: input.cwd,
    env: input.env,
    allowlist: ctx.services.shell_allowlist,
    workspace_cwd: ctx.workspace_cwd,
    path_resolution: ctx.path_resolution,
    file_digest: ctx.file_digest,
  });
  const { token_id, binding } = await mintShellToken({ ctx, tool_name: action.tool_name, form });
  return { approval_token_id: token_id, shell_binding: binding };
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

const EXEC_INTERNET_NOTE = 'This command tries to reach the internet.';

/** Says so on the card when the host flagged the command as reaching the network. */
function withInternetNote({ decision, action }: { decision: TierDecision; action: SentinelAction }): TierDecision {
  if (action.mcp_hints.open_world_hint !== true || decision.card === null) {
    return decision;
  }
  return { ...decision, card: { ...decision.card, plain_what: `${decision.card.plain_what} ${EXEC_INTERNET_NOTE}` } };
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
        cannot_be_undone: 'This changes how programs start, which can make them run other code.',
        why_asked_again: null,
        destination: null,
        recipient: null,
        amount: null,
        parsed_command: command,
        outbound_text: null,
        destination_host: null,
        outbound_truncated: false,
      },
      reason: 'env_overrides_present',
      reason_detail: 'Custom environment variables require approval.',
      sensitive_read: false,
      ...(await mintShellApproval({ ctx, action, command, cwd, env })),
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
    // An allowed offline command continues to the same containment checks as online.
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
    const identity = canonicalFileIdentity({ p: executedOperand, cwd: identityCwd, resolution: ctx.path_resolution });
    if (identity === null) {
      return tier3Decision({
        card: {
          plain_what: `Execute \`${basenameOf(executedOperand)}\`, which the server cannot resolve to a workspace file.`,
          plain_why: plainWhy(ctx.agent_intent),
          cannot_be_undone: 'This runs a file, and it can do anything once started.',
          why_asked_again: null,
          destination: null,
          recipient: null,
          amount: null,
          parsed_command: command,
          outbound_text: null,
          destination_host: null,
          outbound_truncated: false,
        },
        reason: 'tracked_check_unresolvable',
        reason_detail: 'The executed operand could not be resolved; failing closed.',
        sensitive_read: false,
        approval_token_id: await mintPlainToken({ ctx, tool_name: action.tool_name, params: action.canonical_params }),
      });
    }
    if (services.tracked_store.isTracked({ scope: workspaceScope(ctx), file_identity: identity })) {
      const contentHash = await contentDigest({
        identity,
        resolution: ctx.path_resolution,
        digest: ctx.file_digest,
      });
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
            ? await mintPlainToken({ ctx, tool_name: action.tool_name, params: action.canonical_params })
            : await mintPlainToken({ ctx, tool_name: action.tool_name, params: grantParams });
        return tier3Decision({
          card: {
            plain_what: `Execute \`${basenameOf(identity)}\`, a script the agent wrote earlier.`,
            plain_why: plainWhy(ctx.agent_intent),
            cannot_be_undone: 'This script gets full access to your shell.',
            why_asked_again: null,
            destination: null,
            recipient: null,
            amount: null,
            parsed_command: command,
            outbound_text: null,
            destination_host: null,
            outbound_truncated: false,
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
      // An agent-controlled cwd or a symlink escape must not run silently.
      const workspaceRoot = ctx.workspace_cwd;
      if (workspaceRoot === null) {
        // Without a workspace there is nothing to contain the command in, so it must ask.
        return tier3Decision({
          card: {
            plain_what: `Run \`${command}\` where no workspace is set.`,
            plain_why: plainWhy(ctx.agent_intent),
            cannot_be_undone: 'No workspace is set, so this command can read any of your files.',
            why_asked_again: null,
            destination: null,
            recipient: null,
            amount: null,
            parsed_command: command,
            outbound_text: null,
            destination_host: null,
            outbound_truncated: false,
          },
          reason: 'workspace_unknown',
          reason_detail: 'There is no workspace to keep the command inside.',
          sensitive_read: false,
          ...(await mintShellApproval({ ctx, action, command, cwd, env })),
        });
      }
      const cwdInside = isInsideWorkspace({
        p: identityCwd,
        cwd: '/',
        workspace_root: workspaceRoot,
        resolution: ctx.path_resolution,
      });
      if (!cwdInside) {
        return tier3Decision({
          card: {
            plain_what: `Run \`${command}\` from outside the workspace.`,
            plain_why: plainWhy(ctx.agent_intent),
            cannot_be_undone: 'This runs outside your workspace and can reach system files.',
            why_asked_again: null,
            destination: null,
            recipient: null,
            amount: null,
            parsed_command: command,
            outbound_text: null,
            destination_host: null,
            outbound_truncated: false,
          },
          reason: 'cwd_outside_workspace',
          reason_detail: 'The working directory is outside the workspace.',
          sensitive_read: false,
          ...(await mintShellApproval({ ctx, action, command, cwd, env })),
        });
      }
      if (
        !shellOperandsInsideWorkspace({
          parsed,
          cwd: identityCwd,
          workspace_root: workspaceRoot,
          resolution: ctx.path_resolution,
        })
      ) {
        return tier3Decision({
          card: {
            plain_what: `Access a file outside the workspace with \`${command}\`.`,
            plain_why: plainWhy(ctx.agent_intent),
            cannot_be_undone: 'This file is outside your workspace.',
            why_asked_again: null,
            destination: null,
            recipient: null,
            amount: null,
            parsed_command: command,
            outbound_text: null,
            destination_host: null,
            outbound_truncated: false,
          },
          reason: 'file_outside_workspace',
          reason_detail: 'A file operand resolves outside the workspace.',
          sensitive_read: false,
          ...(await mintShellApproval({ ctx, action, command, cwd, env })),
        });
      }
      // Every allowlist entry is read-only by curation (no writes, no network), so a match
      // that passed the checks above runs silently. Anything that failed them asked instead.
      return tier1Decision({
        reason: 'shell_allowlist',
        reason_detail: `Ran allowlisted command \`${parsed.argv[0] ?? command}\`.`,
        sensitive_read: sensitiveReadHit(action.canonical_params),
      });
    }
  }

  // Not allowlisted: Tier 3 with the full parsed binding.
  const form = await canonicalShellFormFor({
    command,
    cwd,
    env,
    allowlist: services.shell_allowlist,
    workspace_cwd: ctx.workspace_cwd,
    path_resolution: ctx.path_resolution,
    file_digest: ctx.file_digest,
  });
  const { token_id, binding } = await mintShellToken({ ctx, tool_name: action.tool_name, form });
  return tier3Decision({
    card: {
      plain_what:
        form.kind === 'compound'
          ? 'Run a compound shell command (pipes, chaining, or redirects).'
          : `Run \`${form.argv[0] ?? command}\` with arguments the safe list does not allow.`,
      plain_why: plainWhy(ctx.agent_intent),
      cannot_be_undone: 'Commands can change or delete files.',
      why_asked_again: null,
      destination: null,
      recipient: null,
      amount: null,
      parsed_command: form.raw_command,
      outbound_text: null,
      destination_host: null,
      outbound_truncated: false,
    },
    reason: 'shell_not_allowlisted',
    reason_detail: 'The command is not on the server-side safe list.',
    sensitive_read: sensitiveReadHit(action.canonical_params),
    shell_binding: binding,
    approval_token_id: token_id,
  });
}

async function mintPlainToken(input: {
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

/** The connector an approval is bound to; only a call that came through a configured connector has one. */
function connectorBindingFor(action: SentinelAction): ConnectorBinding | undefined {
  return action.mcp_server_id === undefined
    ? undefined
    : { server_id: action.mcp_server_id, destination_host: action.mcp_server_host ?? null };
}

async function classifySandboxWrite(action: SentinelAction, ctx: ClassifyContext): Promise<TierDecision> {
  const target = stringParam(action.canonical_params, 'path') ?? stringParam(action.canonical_params, 'target');
  // Relative targets resolve against the call's cwd, matching dispatch.
  const identityCwd = resolveIdentityCwd(ctx, stringParam(action.canonical_params, 'cwd'));
  // Fail closed on null target or missing workspace: treat as outside workspace.
  if (target === null || ctx.workspace_cwd === null) {
    return tier3Decision({
      card: {
        plain_what: 'Write a file outside the workspace.',
        plain_why: plainWhy(ctx.agent_intent),
        cannot_be_undone: 'This file will be saved outside your workspace.',
        why_asked_again: null,
        destination: null,
        recipient: null,
        amount: null,
        parsed_command: null,
        outbound_text: null,
        destination_host: null,
        outbound_truncated: false,
      },
      reason: 'write_outside_workspace',
      reason_detail: 'Write target is null or workspace is unknown.',
      sensitive_read: false,
      approval_token_id: await mintPlainToken({
        ctx,
        tool_name: action.tool_name,
        params: action.canonical_params,
      }),
    });
  }
  // Resolve the write target via its parent directory: the target itself may
  // not exist yet, and resolving it directly would misread every new-file
  // write as outside the workspace.
  const inside = (() => {
    const identity = canonicalWriteTarget({ p: target, cwd: identityCwd, resolution: ctx.path_resolution });
    if (identity === null) {
      return false;
    }
    if (ctx.path_resolution === 'remote') {
      const root = lexicalPath({ p: ctx.workspace_cwd, cwd: '/' });
      return root !== null && isUnderRoot({ identity, root, separator: '/' });
    }
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
        cannot_be_undone: 'This file will be saved outside your workspace.',
        why_asked_again: null,
        destination: null,
        recipient: null,
        amount: null,
        parsed_command: null,
        outbound_text: null,
        destination_host: null,
        outbound_truncated: false,
      },
      reason: 'write_outside_workspace',
      reason_detail: 'Write targets outside the workspace are never Tier 2.',
      sensitive_read: false,
      approval_token_id: await mintPlainToken({
        ctx,
        tool_name: action.tool_name,
        params: action.canonical_params,
      }),
    });
  }
  // Git control files can make later allowlisted git commands run code.
  if (writeTargetTouchesGitControl({ p: target, cwd: identityCwd, resolution: ctx.path_resolution })) {
    return tier3Decision({
      card: {
        plain_what: `Write Git control file \`${target}\`.`,
        plain_why: plainWhy(ctx.agent_intent),
        cannot_be_undone: 'Git settings can make Git run other programs.',
        why_asked_again: null,
        destination: null,
        recipient: null,
        amount: null,
        parsed_command: null,
        outbound_text: null,
        destination_host: null,
        outbound_truncated: false,
      },
      reason: 'git_control_write',
      reason_detail: 'Writes to .git, .gitattributes, and .gitmodules always require approval.',
      sensitive_read: false,
      approval_token_id: await mintPlainToken({
        ctx,
        tool_name: action.tool_name,
        params: action.canonical_params,
      }),
    });
  }
  // Programs and Python startup files in the sandbox tool folders run on later commands and host bookkeeping.
  if (
    writeTargetTouchesSandboxTools({
      p: target,
      cwd: identityCwd,
      roots: [ctx.workspace_cwd],
      resolution: ctx.path_resolution,
    })
  ) {
    return tier3Decision({
      card: {
        plain_what: `Write \`${target}\`, in a folder the sandbox uses for its own tools.`,
        plain_why: plainWhy(ctx.agent_intent),
        cannot_be_undone: 'A file saved there can run in place of a trusted program.',
        why_asked_again: null,
        destination: null,
        recipient: null,
        amount: null,
        parsed_command: null,
        outbound_text: null,
        destination_host: null,
        outbound_truncated: false,
      },
      reason: 'sandbox_tool_write',
      reason_detail: 'Writes into the sandbox tool folders always require approval.',
      sensitive_read: false,
      approval_token_id: await mintPlainToken({
        ctx,
        tool_name: action.tool_name,
        params: action.canonical_params,
      }),
    });
  }
  return decideTier2({
    ctx,
    action,
    kind: 'file_write',
    plain_what: `Change \`${target}\` in your workspace.`,
    parsed_command: null,
    reason: 'sandbox_write',
    reason_detail: `Sandbox file write to \`${target}\`.`,
    sensitive_read: isSensitivePath(target),
  });
}

function classifyRunnerTool(action: SentinelAction, ctx: ClassifyContext): TierDecision {
  const workflowParam = action.canonical_params['workflow'];
  const workflowName = typeof workflowParam === 'string' ? workflowParam : 'unknown';
  // Runner workflows execute agent-controlled package.json script targets,
  // which a Tier 2 relaxation must not be able to auto-run: always Tier 3.
  return tier3Decision({
    card: {
      plain_what: `Run the \`${workflowName}\` workflow (executes package.json scripts).`,
      plain_why: plainWhy(ctx.agent_intent),
      cannot_be_undone: 'This workflow runs scripts Aman can edit.',
      why_asked_again: null,
      destination: null,
      recipient: null,
      amount: null,
      parsed_command: `pnpm ${workflowName}`,
      outbound_text: null,
      destination_host: null,
      outbound_truncated: false,
    },
    reason: 'runner_workflow',
    reason_detail: `Run the \`${workflowName}\` workflow requires approval.`,
    sensitive_read: false,
  });
}

/**
 * Tier 2 asks unless the user relaxed its kind. An unrelaxed call carries a
 * single-use token and parks for approval; a relaxed one runs after the
 * containment re-check.
 */
async function decideTier2(input: {
  ctx: ClassifyContext;
  action: SentinelAction;
  kind: Tier2ActionKind;
  plain_what: string;
  parsed_command: string | null;
  reason: string;
  reason_detail: string;
  sensitive_read: boolean;
}): Promise<TierDecision> {
  const { ctx, action } = input;
  const card = {
    plain_what: input.plain_what,
    plain_why: plainWhy(ctx.agent_intent),
    cannot_be_undone: null,
    why_asked_again: null,
    destination: null,
    recipient: null,
    amount: null,
    parsed_command: input.parsed_command,
    outbound_text: null,
    destination_host: null,
    outbound_truncated: false,
  };
  const base = {
    kind: input.kind,
    card,
    reason: input.reason,
    reason_detail: input.reason_detail,
    sensitive_read: input.sensitive_read,
  };
  const relaxed = await ctx.services.tier2AutoAllow({ tenant_id: ctx.tenant_id, created_by: ctx.created_by });
  if (relaxed.has(input.kind)) {
    return tier2Decision(base);
  }
  return tier2Decision({
    ...base,
    approval_token_id: await mintPlainToken({
      ctx,
      tool_name: action.tool_name,
      params: action.canonical_params,
    }),
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
    if (name.includes('draft')) {
      return `Save an email draft for ${where}.`;
    }
    if (name.includes('forward')) {
      return `Forward an email to ${where}.`;
    }
    if (name.includes('reply')) {
      return `Reply to an email, sending it to ${where}.`;
    }
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

/** Most characters of query text an approval card shows. */
const SEARCH_CARD_TEXT_MAX = 1000;

function searchQueryText(strings: OutboundStrings): string {
  return strings.values
    .map(value => value.trim())
    .filter(value => value !== '')
    .join(' | ');
}

/**
 * A designated-provider call that stops for approval. The card shows the exact text the call would
 * send. An unattended run holds it for the owner like any other call that asks.
 */
async function holdSearchCall(input: {
  action: SentinelAction;
  ctx: ClassifyContext;
  reason: SearchAskReason;
  why: string;
  queryText: string;
  fields: ExtractionResult['fields'];
}): Promise<TierDecision> {
  const { action, ctx, fields } = input;
  const shown =
    input.queryText.length > SEARCH_CARD_TEXT_MAX
      ? `${input.queryText.slice(0, SEARCH_CARD_TEXT_MAX)}...`
      : input.queryText;
  const server = action.mcp_server_name ?? 'the search provider';
  return tier3Decision({
    card: {
      plain_what: `Search the web through ${server} for: ${shown}`,
      plain_why: plainWhy(ctx.agent_intent),
      cannot_be_undone: null,
      why_asked_again: input.why === '' ? null : `Held for approval: ${input.why}.`,
      destination: action.mcp_server_name ?? null,
      recipient: null,
      amount: null,
      parsed_command: null,
      outbound_text: fields.outbound_text,
      destination_host: fields.destination_host,
      outbound_truncated: fields.outbound_truncated,
    },
    reason: input.reason,
    reason_detail: input.why === '' ? 'Searches are set to ask.' : `Web search held: ${input.why}.`,
    sensitive_read: false,
    approval_token_id: await mintPlainToken({
      ctx,
      tool_name: action.tool_name,
      params: action.canonical_params,
      connector: connectorBindingFor(action),
    }),
  });
}

/**
 * The designated search provider's call. Runs without asking unless the user switched searches to
 * ask, the outbound secret guard trips, the turn already ran its allowance of silent searches, or
 * the call names a URL no search result of this turn returned. Returns undefined, leaving the call
 * to the ordinary rules, for a tool that the server did not declare read-only and the host's list
 * does not name as a search tool, that declares itself destructive or not read-only, falls in a
 * name-based escalation class, or touches a sensitive path: the role never lowers those, so
 * designating a connector that can write does not make its unannotated tools silent.
 */
async function classifySearchProviderTool(input: {
  action: SentinelAction;
  ctx: ClassifyContext;
  extraction: ExtractionResult;
}): Promise<TierDecision | undefined> {
  const { action, ctx, extraction } = input;
  const name = action.tool_name.toLowerCase();
  if (
    (action.mcp_hints.read_only_hint !== true && action.mcp_search_tool !== true) ||
    action.mcp_hints.destructive_hint === true ||
    action.mcp_hints.read_only_hint === false ||
    extraction.external_service ||
    DESTRUCTIVE_FRAGMENTS.some(fragment => name.includes(fragment)) ||
    INSTALL_FRAGMENTS.some(fragment => name.includes(fragment)) ||
    sensitiveReadHit(action.canonical_params)
  ) {
    return undefined;
  }
  const owner = { tenant_id: ctx.tenant_id, created_by: ctx.created_by };
  const strings = collectOutboundStrings(action.canonical_params);
  const queryText = strings === undefined ? '' : searchQueryText(strings);
  const held = (reason: SearchAskReason, why: string): Promise<TierDecision> =>
    holdSearchCall({ action, ctx, reason, why, queryText, fields: extraction.fields });

  if (!(await ctx.services.searchWithoutAsking(owner))) {
    return held('mcp_search_setting_ask', '');
  }
  const verdict =
    strings === undefined
      ? ({ ok: false, rule: 'uninspectable' } as const)
      : checkOutboundStrings({
          strings,
          secrets: await ctx.services.outboundSecrets(owner),
          earlier: ctx.web_search.sentText,
        });
  if (!verdict.ok) {
    return held('mcp_search_guard', describeOutboundRule(verdict.rule));
  }
  if (ctx.web_search.silentSearches >= SILENT_SEARCH_LIMIT) {
    return held('mcp_search_limit', `this turn already ran ${String(SILENT_SEARCH_LIMIT)} searches without asking`);
  }
  if (strings !== undefined && unreturnedUrls({ values: strings.values, state: ctx.web_search }).length > 0) {
    return held('mcp_search_unreturned_url', 'it names a link that no search result this turn returned');
  }
  return tier1Decision({
    reason: SEARCH_SILENT_REASON,
    reason_detail: `Searched: ${queryText}`,
    sensitive_read: false,
    silent_search_query: queryText,
  });
}

async function classifyGenericTool(action: SentinelAction, ctx: ClassifyContext): Promise<TierDecision> {
  const { services } = ctx;
  const name = action.tool_name.toLowerCase();

  // Offline: network-required tools are filtered from the list; a stale call
  // that slips through is auto-denied here.
  const offline = await services.isOffline({ tenant_id: ctx.tenant_id, created_by: ctx.created_by });
  const extraction = extractCardFields({
    tool_name: action.tool_name,
    canonical_params: action.canonical_params,
    tool_type: action.tool_type,
    server_host: action.mcp_server_host,
    server_name: action.mcp_server_name,
  });
  if (offline) {
    if (extraction.external_service) {
      return autoDenyDecision({
        reason: 'offline_mode',
        reason_detail: 'External-service actions are disabled while offline.',
        sensitive_read: false,
      });
    }
    if (requiresNetwork({ tool_name: action.tool_name, provenance: provenanceForToolType(action.tool_type) })) {
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

  // The user's designated search provider runs without asking behind the outbound secret guard.
  if (action.tool_type === 'mcp' && action.mcp_search_provider === true) {
    const searchDecision = await classifySearchProviderTool({ action, ctx, extraction });
    if (searchDecision !== undefined) {
      return searchDecision;
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
        // The external-service sentence wins: it is the more specific warning about where this goes.
        plain_what: extraction.external_service
          ? externalServiceWhat({
              tool_name: action.tool_name,
              destination: fields.destination,
              recipient: fields.recipient,
              amount: fields.amount,
            })
          : destructiveHint || extraction.connector_what === null
            ? `Run ${action.tool_name}, flagged as ${destructiveHint ? 'destructive' : 'reaching outside this machine'}.`
            : extraction.connector_what,
        plain_why: plainWhy(ctx.agent_intent),
        cannot_be_undone: destructiveHint
          ? 'This might change or delete something for good.'
          : "Once this is sent, it can't be unsent.",
        why_asked_again: null,
        destination: fields.destination,
        recipient: fields.recipient,
        amount: fields.amount,
        parsed_command: null,
        outbound_text: fields.outbound_text,
        destination_host: fields.destination_host,
        outbound_truncated: fields.outbound_truncated,
      },
      reason: destructiveHint ? 'mcp_destructive_hint' : 'mcp_open_world_hint',
      reason_detail: 'MCP annotations flagged the tool; hints escalate only.',
      sensitive_read: sensitiveReadHit(action.canonical_params),
      escalated: true,
      approval_token_id: await mintPlainToken({
        ctx,
        tool_name: action.tool_name,
        params: action.canonical_params,
        connector: connectorBindingFor(action),
      }),
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
        cannot_be_undone: isDestructive ? "Once deleted, it's gone for good." : "Once this runs, it can't be undone.",
        why_asked_again: null,
        destination: fields.destination,
        recipient: fields.recipient,
        amount: fields.amount,
        parsed_command: null,
        outbound_text: fields.outbound_text,
        destination_host: fields.destination_host,
        outbound_truncated: fields.outbound_truncated,
      },
      reason: extraction.external_service ? 'external_service' : isInstall ? 'install_action' : 'destructive_action',
      reason_detail: 'Name-based Tier 3 class.',
      sensitive_read: sensitiveReadHit(action.canonical_params),
      approval_token_id: await mintPlainToken({
        ctx,
        tool_name: action.tool_name,
        params: action.canonical_params,
        connector: connectorBindingFor(action),
      }),
    });
  }

  // A connector tool's own hints never lower it. Trust in the connector (first-party) or in the
  // tool (the user's standing grant) skips the card, but only after every escalation above, never
  // for a sensitive read, and only while the tool still claims to be read-only and explicitly
  // closed-world (an absent openWorldHint means open).
  if (
    action.tool_type === 'mcp' &&
    readOnlyHint &&
    action.mcp_hints.open_world_hint === false &&
    !sensitiveReadHit(action.canonical_params)
  ) {
    if (action.mcp_first_party === true) {
      return tier1Decision({
        reason: FIRST_PARTY_TOOL_REASON,
        reason_detail: `First-party read-only tool \`${action.tool_name}\`${
          action.mcp_server_name === undefined ? '' : ` on ${action.mcp_server_name}`
        }.`,
        sensitive_read: false,
      });
    }
    if (
      action.mcp_server_name !== undefined &&
      (await services.tool_grants.hasToolGrant({
        tenant_id: ctx.tenant_id,
        created_by: ctx.created_by,
        mcp_server_name: action.mcp_server_name,
        tool_name: action.tool_name,
      }))
    ) {
      return tier1Decision({
        reason: TOOL_GRANT_REASON,
        reason_detail: `Always allowed: \`${action.tool_name}\` on ${action.mcp_server_name}.`,
        sensitive_read: false,
      });
    }
  }

  // Host built-in read-only tools: Tier 1.
  if (action.tool_type === 'truefoundry-system' && readOnlyHint && !openWorldHint) {
    return tier1Decision({
      reason: 'local_read_only',
      reason_detail: `Local read-only tool \`${action.tool_name}\`.`,
      sensitive_read: sensitiveReadHit(action.canonical_params),
    });
  }

  // Fail closed: anything unrecognized is Tier 3 with a card.
  const card = connectorApprovalCard({ action, extraction, agent_intent: ctx.agent_intent });
  const recognized = extraction.connector_what !== null;
  return tier3Decision({
    card,
    reason: recognized ? 'connector_outbound' : 'unrecognized_tool',
    reason_detail: recognized
      ? 'Connector call that sends data out; always asks.'
      : 'Fail-closed: unrecognized tools require approval.',
    sensitive_read: sensitiveReadHit(action.canonical_params),
    approval_token_id: await mintPlainToken({
      ctx,
      tool_name: action.tool_name,
      params: action.canonical_params,
      connector: connectorBindingFor(action),
    }),
  });
}

/**
 * The card for a call that has to ask but matched no more specific class. A connector call shows its
 * exact arguments and server host, and a known search, fetch, write or mail tool is named in plain
 * words. Pure: it mints nothing, so it can also describe an approval that was gated some other way.
 */
function connectorApprovalCard(input: {
  action: SentinelAction;
  extraction: ExtractionResult;
  agent_intent: string | null;
}): Tier3Card {
  const { action, extraction } = input;
  const { fields } = extraction;
  return {
    plain_what: extraction.connector_what ?? `Aman doesn't know this tool yet: ${escapeDisplayText(action.tool_name)}.`,
    plain_why: plainWhy(input.agent_intent),
    cannot_be_undone:
      extraction.connector_what === null
        ? 'Check the details before you go ahead.'
        : "Once this is sent, it can't be unsent.",
    why_asked_again: null,
    destination: fields.destination,
    recipient: fields.recipient,
    amount: fields.amount,
    parsed_command: null,
    outbound_text: fields.outbound_text,
    destination_host: fields.destination_host,
    outbound_truncated: fields.outbound_truncated,
  };
}

/**
 * The card for an approval that no classifier decision carded, such as a call a selector gates
 * though Sentinel let it through. It describes the call the same way an unrecognized one is
 * described, so every approval the user is asked for reads the same.
 */
export function approvalCardForGatedCall(input: { action: SentinelAction; agent_intent: string | null }): Tier3Card {
  const { action } = input;
  return connectorApprovalCard({
    action,
    extraction: extractCardFields({
      tool_name: action.tool_name,
      canonical_params: action.canonical_params,
      tool_type: action.tool_type,
      server_host: action.mcp_server_host,
      server_name: action.mcp_server_name,
    }),
    agent_intent: input.agent_intent,
  });
}

/**
 * The single authoritative tier classifier. Fail-closed on anything
 * unrecognized; MCP hints escalate, and lower a connector tool only through
 * first-party trust or a standing grant.
 */
export async function classifyTier(action: SentinelAction, ctx: ClassifyContext): Promise<TierDecision> {
  const name = action.tool_name;

  // Only the verified system exec tool gets the allowlist path. An MCP tool
  // named 'exec' must not be downgraded to Tier 2; it falls through to the
  // fail-closed Tier 3 default below.
  if (action.tool_type === 'truefoundry-system') {
    if (name === 'exec') {
      return withInternetNote({ decision: await classifyExecShell(action, ctx), action });
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
            name === 'run_code'
              ? 'Run code the agent wrote in the sandbox.'
              : 'Submit an implementation plan for review.',
          plain_why: plainWhy(ctx.agent_intent),
          cannot_be_undone: "Once this runs, it can't be undone.",
          why_asked_again: null,
          destination: null,
          recipient: null,
          amount: null,
          parsed_command: null,
          outbound_text: null,
          destination_host: null,
          outbound_truncated: false,
        },
        reason: name === 'run_code' ? 'arbitrary_code_execution' : 'plan_submission',
        reason_detail: 'Always Tier 3 by policy.',
        sensitive_read: false,
        approval_token_id: await mintPlainToken({
          ctx,
          tool_name: action.tool_name,
          params: action.canonical_params,
        }),
      });
    }
    // Embedded maps: always Tier 3, whatever hints the tool declares. The card
    // names the place strings verbatim and the configured hosts from server
    // config; the destination never comes from model params.
    if (isMapsToolAlwaysTier3(name)) {
      // Offline outranks the card: a stale call is denied, not offered for approval.
      if (await ctx.services.isOffline({ tenant_id: ctx.tenant_id, created_by: ctx.created_by })) {
        return autoDenyDecision({
          reason: 'offline_mode',
          reason_detail: 'Maps need network access, which is disabled while offline.',
          sensitive_read: false,
        });
      }
      const outbound = renderOutboundArguments(action.canonical_params);
      return tier3Decision({
        card: {
          plain_what: mapsPlainWhat(action),
          plain_why: plainWhy(ctx.agent_intent),
          cannot_be_undone: null,
          why_asked_again: null,
          destination: null,
          recipient: null,
          amount: null,
          parsed_command: null,
          outbound_text: outbound.text,
          destination_host: action.maps_hosts === undefined ? null : mapsDestinationHosts(action.maps_hosts),
          outbound_truncated: outbound.truncated,
        },
        reason: 'maps_tool',
        reason_detail: 'Maps tools are always Tier 3 by policy.',
        sensitive_read: false,
        approval_token_id: await mintPlainToken({
          ctx,
          tool_name: action.tool_name,
          params: action.canonical_params,
          connector: connectorBindingFor(action),
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
  /** How the calling tool's paths are resolved; absent means the server's own filesystem. */
  path_resolution?: PathResolution | undefined;
  /** Reads file digests from the calling tool's remote sandbox. */
  file_digest?: FileDigest | undefined;
}): Promise<TierDecision> {
  // Normalize canonical params to JSON form once, here, so every caller mints
  // approval tokens over the same value the verify path re-parses from the
  // serialized arguments string (see toJsonSafeParams).
  const action: SentinelAction = {
    ...input.action,
    canonical_params: toJsonSafeParams(input.action.canonical_params),
  };
  const ctx = classifyContextFor({
    host: input.sentinel,
    repository_id: input.repository_id,
    workspace_cwd: input.workspace_cwd,
  });
  const decision = await classifyTier(action, {
    ...ctx,
    path_resolution: input.path_resolution,
    file_digest: input.file_digest,
  });
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
    tool_name: action.tool_name,
    decision,
  });
  return decision;
}

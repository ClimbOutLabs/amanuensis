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
import { existsSync, readFileSync, realpathSync } from 'fs';
import os from 'os';
import path from 'path';
import type { CalendarWriteReview } from '../calendar/eventWrite';
import { CALENDAR_SERVER_ID, isCalendarReadToolName, isCalendarWriteToolName } from '../calendar/toolContract';
import type { ReviewableDraft } from '../email/gmail/draftReview';
import type { AnsweredMessage } from '../email/gmail/replyThread';
import {
  GMAIL_SERVER_ID,
  isGmailReadToolName,
  isGmailWriteToolName,
  SEND_DRAFT_TOOL_NAME,
  UPDATE_DRAFT_TOOL_NAME,
} from '../email/gmail/toolContract';
import { mailRecipientsNotListed } from '../email/mailConnector/recipientList';
import { isMailSend } from '../email/mailConnector/sendListApproval';
import { isMailReadToolName, MAIL_CONNECTOR_NAME } from '../email/mailConnector/toolContract';
import type { MapsHosts } from '../llm/LLMTypes';
import {
  isPersonaWriteToolName,
  LIST_PERSONAS_TOOL_NAME,
  PERSONA_SERVER_ID,
  USE_PERSONA_TOOL_NAME,
} from '../personas/toolContract';
import {
  isScheduleStatusToolName,
  isScheduleWriteToolName,
  LIST_SCHEDULES_TOOL_NAME,
  SCHEDULE_SERVER_ID,
} from '../schedules/toolContract';
import { tavilyApprovalWhat } from '../search/tavilyCardText';
import {
  CREATE_SPACE_TOOL_NAME,
  GET_SPACE_TOOL_NAME,
  isSpaceReadToolName,
  isSpaceWriteToolName,
  LIST_BLOCKS_TOOL_NAME,
  LIST_SPACES_TOOL_NAME,
  REVERT_SPACE_TOOL_NAME,
  SPACE_SERVER_ID,
  UPDATE_SPACE_TOOL_NAME,
} from '../spaces/toolContract';
import { absolutePatchTarget, applyPatchTargets } from './applyPatchTargets';
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
import { FIRST_PARTY_TOOL_REASON, MAIL_READ_REASON } from './connectorTrust';
import {
  classifyContextFor,
  type SentinelCallIdentity,
  type SentinelHostContext,
  type SentinelServices,
} from './context';
import { escapeDisplayText } from './displayText';
import {
  extractCardFields,
  isCalendarChangeToolName,
  renderOutboundArguments,
  type ExtractionResult,
} from './extractorRegistry';
import { DEFAULT_MAPS_TRAVEL_MODE, MapsTravelModeSchema } from './mapsRouteSchemas';
import {
  isMapsToolName,
  MAPS_ASK_REASON,
  MAPS_SILENT_REASON,
  RENDER_PLACES_TOOL_NAME,
  RENDER_ROUTE_TOOL_NAME,
} from './mapsToolNames';
import { provenanceForToolType, requiresNetwork } from './networkRequirements';
import {
  appendOutboundTrace,
  checkOutboundStrings,
  collectOutboundStrings,
  describeOutboundRule,
  maskServerSecrets,
  type OutboundGuardVerdict,
  type OutboundStrings,
} from './outboundGuard';
import { namesUrl, steeredDestinations, steeredLinks } from './provenance';
import { isRunnerWorkflow } from './runner';
import { scriptFileLoadsOnlyStandardCode, scriptLoadsOnlyStandardCode } from './scriptImports';
import {
  guardRuleSay,
  holdSay,
  SEARCH_SERVER_FALLBACK,
  searchHoldAuditText,
  searchHoldCardText,
  searchProviderLabel,
  SECRET_SAY,
  steeredDestinationSay,
  withHoldSay,
} from './searchHoldText';
import { containsPathLikeValue, containsSecretPath, namesSecretPath } from './secretPaths';
import { DEMO_CONNECTOR_REFUSAL, DEMO_SEND_REFUSAL, recipientsAllowed } from './sendAllowlist';
import {
  hashArgv,
  matchAllowlist,
  OFFLINE_SHELL_COMMANDS,
  parseReadOnlyList,
  parseSimpleCommand,
  type ParsedSimpleCommand,
  type ReadOnlyList,
  type ShellAllowlistConfig,
} from './shellAllowlist';
import {
  autoDenyDecision,
  CONTENT_STEERED_REASON,
  failClosedDecision,
  SANDBOX_COMMAND_REASON,
  SANDBOX_FILE_WRITE_REASON,
  SANDBOX_PACKAGE_INSTALL_REASON,
  SANDBOX_RUN_CODE_REASON,
  tier1Decision,
  tier2Decision,
  tier3Decision,
  type Tier2ActionKind,
  type Tier3Card,
  type Tier3Persona,
  type Tier3Schedule,
  type TierDecision,
  type TrackedExecutionBinding,
} from './tier';
import { mailboxText, type Tier3Mailbox } from './tierMailbox';
import { TOOL_GRANT_REASON } from './toolGrants';
import {
  canonicalFileIdentity,
  canonicalWriteIdentity,
  canonicalWriteTarget,
  contentDigest,
  extractExecutedFileOperand,
  isInsideWorkspace,
  isNewWriteTarget,
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
  SEARCH_STEERED_REASON,
  SILENT_SEARCH_LIMIT,
  type SearchAskReason,
  type WebSearchTurnState,
} from './webSearch';

import type { CaldavEventReview } from '../calendar/caldav/eventReview';
import { classifyCaldavTool } from './caldavTier';

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
  /** The CalDAV event a change names, read once before classifying. Set only for the CalDAV connector. */
  caldav_event?: CaldavEventReview | null | undefined;
  /** The user designated this connector as their search provider. Set by the host from the connector record only. */
  mcp_search_provider?: boolean | undefined;
  /** The host's own list for the designated provider names this tool as a search tool. Never from tool metadata. */
  mcp_search_tool?: boolean | undefined;
  /** Top-level argument names the catalog declares as the designated provider's plumbing (session id, model name). Never from tool metadata. */
  mcp_search_plumbing_fields?: readonly string[] | undefined;
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
  /**
   * The message a Gmail write would send or save, as the host holds it. Set by the Gmail tool set from a live
   * read and the validated call, so the card shows what would really go out.
   */
  mail_draft?: ReviewableDraft | undefined;
  /** For a draft change: the saved draft it replaces, as Gmail holds it now. */
  mail_replaces?: ReviewableDraft | undefined;
  /** For a reply: the message in its own thread that it answers, read by the host from Gmail. */
  mail_reply_in_thread?: AnsweredMessage | undefined;
  /**
   * The event a Calendar write would add or change, settled by the Calendar tool set from the validated call and,
   * for a change, the event as Google holds it now, so the card shows what would really be written.
   */
  calendar_write?: CalendarWriteReview | undefined;
  /** The schedule a create or delete would save or remove, settled by the schedule tool set from the store. */
  schedule_write?: Tier3Schedule | undefined;
  /** The persona a create would add, settled by the persona tool set from the request and the owner's personas. */
  persona_write?: Tier3Persona | undefined;
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
  return escapeDisplayText(JSON.stringify(shown));
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
  const parts = [
    mapsHost(hosts.geocoder),
    mapsHost(hosts.router),
    mapsHost(hosts.walking),
    mapsHost(hosts.cycling),
    mapsHost(hosts.transit),
    mapsHost(hosts.tile),
  ];
  return [...new Set(parts)].join(', ');
}

/** The route service the card names for the call's travel mode, and what it is asked for. */
function mapsRouteService({ mode, hosts }: { mode: unknown; hosts: MapsHosts | undefined }): string {
  const parsed = mode === undefined ? DEFAULT_MAPS_TRAVEL_MODE : MapsTravelModeSchema.safeParse(mode).data;
  switch (parsed) {
    case 'walking':
      return `ask ${mapsHost(hosts?.walking)} for a walking route between them`;
    case 'cycling':
      return `ask ${mapsHost(hosts?.cycling)} for a cycling route between them`;
    case 'transit':
      return `ask ${mapsHost(hosts?.transit)} for a public transport route between them`;
    case 'driving':
      return `ask ${mapsHost(hosts?.router)} for a driving route between them`;
    default:
      return `ask ${mapsHost(hosts?.router)}, ${mapsHost(hosts?.walking)}, ${mapsHost(hosts?.cycling)} or ${mapsHost(hosts?.transit)} for a route between them`;
  }
}

/** Most addresses one pin call may send; the tool schema caps the list at the same number. */
const PLACES_CARD_MAX = 3;

/** The addresses a render_places call would send to the geocoder, as the model wrote them. */
function placeAddresses(params: Record<string, unknown>): unknown[] {
  const places = params['places'];
  if (!Array.isArray(places)) {
    return [];
  }
  return places
    .slice(0, PLACES_CARD_MAX)
    .map((place: unknown) =>
      typeof place === 'object' && place !== null && 'address' in place ? place.address : undefined,
    );
}

/** Only the addresses leave the machine, so only they are the outbound text of a pin call. */
function placesOutboundArguments(params: Record<string, unknown>): Record<string, unknown> {
  const addresses = placeAddresses(params);
  return Object.fromEntries(
    addresses.map((address, index) => [
      addresses.length === 1 ? 'address' : `address_${String(index + 1)}`,
      address === undefined ? '(not text)' : address,
    ]),
  );
}

function joinedLabels(values: readonly unknown[]): string {
  const labels = values.map(mapsCardLabel);
  const last = labels.pop();
  return labels.length === 0 ? (last ?? '') : `${labels.join(', ')} and ${last ?? ''}`;
}

/** Card plain_what naming the quoted place strings and the configured hosts. */
function mapsPlainWhat(action: SentinelAction): string {
  const params = action.canonical_params;
  const hosts = action.maps_hosts;
  const geocoder = mapsHost(hosts?.geocoder);
  const tile = mapsHost(hosts?.tile);
  if (action.tool_name === RENDER_ROUTE_TOOL_NAME) {
    return (
      `Send ${mapsCardLabel(params['from_place'])} and ${mapsCardLabel(params['to_place'])} to ${geocoder}, ` +
      `${mapsRouteService({ mode: params['mode'], hosts })}, then load map tiles for that area from ${tile}.`
    );
  }
  if (action.tool_name === RENDER_PLACES_TOOL_NAME) {
    return (
      `Send the addresses ${joinedLabels(placeAddresses(params))} to ${geocoder} to find where they are, ` +
      `then load map tiles for that area from ${tile}. The details on each pin come from pages Aman already read.`
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
    conversation_id: ctx.conversation_id,
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

/**
 * Whether every step of a read-only list stays inside the workspace: each `cd` lands inside it, and each command's
 * operands resolve inside it from the directory that step runs in.
 */
function readOnlyListInsideWorkspace(input: {
  list: ReadOnlyList;
  cwd: string;
  workspace_root: string;
  resolution: PathResolution | undefined;
}): boolean {
  const { resolution, workspace_root } = input;
  let cwd = input.cwd;
  for (const step of input.list.steps) {
    if (step.kind === 'run') {
      if (!shellOperandsInsideWorkspace({ parsed: step.parsed, cwd, workspace_root, resolution })) {
        return false;
      }
      continue;
    }
    const target = canonicalFileIdentity({ p: step.dir, cwd, resolution });
    if (target === null || !isInsideWorkspace({ p: target, cwd: '/', workspace_root, resolution })) {
      return false;
    }
    cwd = target;
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

/** Package managers whose installs go through the sandbox package gateway. */
const PACKAGE_MANAGER_COMMANDS: ReadonlySet<string> = new Set(['npm', 'pnpm', 'yarn', 'pip', 'pip3']);

/** Install flags that only change how packages are saved or reported. Any other flag asks. */
const SAFE_INSTALL_FLAGS: ReadonlySet<string> = new Set([
  '-q',
  '--quiet',
  '-U',
  '--upgrade',
  '--no-input',
  '-D',
  '--save-dev',
  '-S',
  '--save',
]);

/** A package name with an optional scope, extras, and version pin. A web address, a path, or a bare dot name does not match. */
const PLAIN_PACKAGE_SPEC =
  /^(?!\.+$)(@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+(\[[A-Za-z0-9,._-]+\])?([=<>!~^@]{1,2}[A-Za-z0-9.*_+-]+)?$/u;

/** `python -m pip` runs the same pip, so its argv is classified as pip's. */
function pipEquivalentArgv(argv: readonly string[]): readonly string[] {
  const [program, flag, module] = argv;
  if ((program === 'python' || program === 'python3') && flag === '-m' && module === 'pip') {
    return ['pip', ...argv.slice(3)];
  }
  return argv;
}

function isPackageInstallArgv(input: readonly string[]): boolean {
  const argv = pipEquivalentArgv(input);
  const [program, subcommand] = argv;
  if (program === undefined || subcommand === undefined || !PACKAGE_MANAGER_COMMANDS.has(program)) {
    return false;
  }
  return program === 'pip' || program === 'pip3'
    ? subcommand === 'install'
    : ['install', 'add', 'i'].includes(subcommand);
}

/**
 * Installers whose install scripts run the package's own code, and so run code from the repository on a
 * local path. Their silent installs must pass IGNORE_SCRIPTS_FLAG. pip always runs build hooks and .pth
 * files, so every pip install keeps its card.
 */
const SCRIPT_RUNNING_INSTALLERS: ReadonlySet<string> = new Set(['npm', 'pnpm', 'yarn']);
const IGNORE_SCRIPTS_FLAG = '--ignore-scripts';

/**
 * Files that can turn install scripts or install hooks back on. Any one of them present in a folder the
 * install reads from means the install asks.
 */
const INSTALL_HOOK_FILES: readonly string[] = [
  '.pnpmfile.cjs',
  '.pnpmfile.mjs',
  '.npmrc',
  '.yarnrc',
  '.yarnrc.yml',
  'pnpm-workspace.yaml',
];

/** Installers whose hook files and install-script defaults change by version, so the version must be declared. */
const VERSION_GATED_INSTALLERS: ReadonlySet<string> = new Set(['pnpm', 'yarn']);

/** A packageManager field that names pnpm or yarn with a full version, such as `pnpm@11.16.0+sha512...`. */
const DECLARED_PACKAGE_MANAGER = /^(pnpm|yarn)@\d+\.\d+\.\d+/u;

/**
 * True when the install names only plain packages, so every download goes through the package gateway,
 * and it runs no install scripts. Any pip install, and any npm, pnpm or yarn install without the ignore flag, asks.
 */
function isPlainPackageInstall(input: readonly string[]): boolean {
  if (!isPackageInstallArgv(input)) {
    return false;
  }
  const argv = pipEquivalentArgv(input);
  const [program] = argv;
  if (program === undefined || !SCRIPT_RUNNING_INSTALLERS.has(program)) {
    return false;
  }
  const operands = argv.slice(2);
  const packages = operands.filter(word => !word.startsWith('-'));
  const flags = operands.filter(word => word.startsWith('-'));
  return (
    packages.length > 0 &&
    packages.every(spec => PLAIN_PACKAGE_SPEC.test(spec)) &&
    flags.includes(IGNORE_SCRIPTS_FLAG) &&
    flags.every(flag => flag === IGNORE_SCRIPTS_FLAG || SAFE_INSTALL_FLAGS.has(flag))
  );
}

/**
 * The install's own folder, then each folder above it up to the workspace root. An install outside the workspace
 * walks up to the filesystem root, which is the wider check.
 */
function installFolderChain({ base, root }: { base: string; root: string | null }): string[] {
  const stop = root === null ? null : path.resolve(root);
  const folders: string[] = [];
  for (let dir = path.resolve(base); ; dir = path.dirname(dir)) {
    folders.push(dir);
    if (dir === stop || path.dirname(dir) === dir) {
      return folders;
    }
  }
}

/** Whether a file that can re-enable install scripts or hooks sits where the install reads from. */
async function installHooksPresent({ ctx, cwd }: { ctx: ClassifyContext; cwd: string | null }): Promise<boolean> {
  // A remote sandbox with no file reader cannot rule the hook files out, so the install asks.
  if (ctx.path_resolution === 'remote' && ctx.file_digest === undefined) {
    return true;
  }
  const base = resolveIdentityCwd(ctx, cwd);
  const folders = [...installFolderChain({ base, root: ctx.workspace_cwd }), os.homedir()];
  for (const folder of folders) {
    for (const name of INSTALL_HOOK_FILES) {
      // The file may not exist, so its folder is resolved and the name appended, not the whole path.
      const identity = canonicalWriteTarget({ p: name, cwd: folder, resolution: ctx.path_resolution });
      if (identity === null) {
        return true;
      }
      const digest = await contentDigest({ identity, resolution: ctx.path_resolution, digest: ctx.file_digest });
      if (digest !== null) {
        return true;
      }
    }
  }
  return false;
}

/** The packageManager field of a package.json, or null when the file cannot be read or names none. */
function declaredPackageManager(manifest: string): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifest, 'utf8'));
    if (typeof parsed === 'object' && parsed !== null && 'packageManager' in parsed) {
      return typeof parsed.packageManager === 'string' ? parsed.packageManager : null;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * True when the package.json nearest the install names this installer's version. Its hook files and script
 * defaults depend on that version, so an install whose version is unknown asks. A remote sandbox cannot be
 * read from here, so its version is never known.
 */
function installerVersionDeclared({
  installer,
  ctx,
  cwd,
}: {
  installer: string;
  ctx: ClassifyContext;
  cwd: string | null;
}): boolean {
  if (ctx.path_resolution === 'remote') {
    return false;
  }
  const base = resolveIdentityCwd(ctx, cwd);
  const manifest = installFolderChain({ base, root: ctx.workspace_cwd })
    .map(folder => path.join(folder, 'package.json'))
    .find(file => existsSync(file));
  if (manifest === undefined) {
    return false;
  }
  const declared = declaredPackageManager(manifest) ?? '';
  return DECLARED_PACKAGE_MANAGER.exec(declared)?.[1] === installer;
}

/** The plain line the activity list shows for a silent run. */
function sandboxRunDetail(command: string): string {
  return `Ran in the sandbox: ${escapeDisplayText(command)}`;
}

/**
 * Interpreters a silent run may start. Shells are left out: the shell parser rejects `sh` and `bash` as
 * wrappers, so a shell script keeps its card.
 */
const IMAGE_RUNTIMES: ReadonlySet<string> = new Set(['python', 'python3', 'node']);

/** Options an interpreter may take before its script. None of them starts code other than that script. */
const SILENT_RUNTIME_OPTIONS: ReadonlySet<string> = new Set(['-u', '-B', '-E', '-I', '-O']);

/**
 * The script a silent run would execute: an image runtime, safe options, then a script path. Inline code
 * (`-c`, `-e`), a module (`-m`), stdin (`-`), and any other program have no such script and return undefined.
 */
function silentRunScript(argv: readonly string[]): string | undefined {
  const [program, ...rest] = argv;
  if (program === undefined || !IMAGE_RUNTIMES.has(program)) {
    return undefined;
  }
  let index = 0;
  while (index < rest.length && SILENT_RUNTIME_OPTIONS.has(rest[index] ?? '')) {
    index += 1;
  }
  const script = rest[index];
  if (script === undefined || script.startsWith('-')) {
    return undefined;
  }
  return script;
}

/**
 * The silent run a command gets with the switch on: a plain package install, or a script run of a file Aman
 * wrote in this conversation. A script run of any other file (a repo file, a download, an unknown file) keeps
 * its card, and so does a test runner, which runs code it finds in the repo.
 */
async function sandboxRunPlacement({
  command,
  parsed,
  ctx,
  cwd,
}: {
  command: string;
  parsed: ParsedSimpleCommand | undefined;
  ctx: ClassifyContext;
  cwd: string | null;
}): Promise<{ reason: string; reason_detail: string } | null> {
  if (parsed === undefined) {
    return null;
  }
  const program = parsed.argv[0];
  if (program === undefined) {
    return null;
  }
  // An install that is not plain (index URL, path, web address, requirements file) asks, whatever its program.
  if (isPackageInstallArgv(parsed.argv)) {
    const installer = pipEquivalentArgv(parsed.argv)[0] ?? '';
    const versionUnknown =
      VERSION_GATED_INSTALLERS.has(installer) && !installerVersionDeclared({ installer, ctx, cwd });
    if (!isPlainPackageInstall(parsed.argv) || versionUnknown || (await installHooksPresent({ ctx, cwd }))) {
      return null;
    }
    return { reason: SANDBOX_PACKAGE_INSTALL_REASON, reason_detail: sandboxRunDetail(command) };
  }
  const script = silentRunScript(parsed.argv);
  if (script === undefined) {
    return null;
  }
  const identity = canonicalFileIdentity({
    p: script,
    cwd: resolveIdentityCwd(ctx, cwd),
    resolution: ctx.path_resolution,
  });
  if (
    identity === null ||
    !ctx.services.tracked_store.isTracked({ scope: workspaceScope(ctx), file_identity: identity })
  ) {
    return null;
  }
  // A script that loads other code (an import of a non-standard module, a dynamic import, a child process)
  // can run files from the workspace, so only a script that stays within the standard library runs silently.
  if (
    !scriptFileLoadsOnlyStandardCode({
      runtime: program === 'node' ? 'node' : 'python',
      file: identity,
      resolution: ctx.path_resolution,
    })
  ) {
    return null;
  }
  return { reason: SANDBOX_COMMAND_REASON, reason_detail: sandboxRunDetail(command) };
}

/**
 * The silent run of `run_code`: code Aman wrote in this chat, given as the call's own `code` or as a file it
 * wrote this session. It passes the same install and code-origin checks as a silent command. Code that starts
 * a program or loads anything beyond the standard library keeps its card.
 */
async function runCodePlacement({
  params,
  ctx,
}: {
  params: Record<string, unknown>;
  ctx: ClassifyContext;
}): Promise<{ reason: string; reason_detail: string } | null> {
  const code = stringParam(params, 'code');
  const scriptPath = stringParam(params, 'script_path');
  // The call names exactly one program source, and a runtime this check can read.
  if ((code === null) === (scriptPath === null)) {
    return null;
  }
  const language = stringParam(params, 'language');
  const runtime = language === 'python' || language === 'node' ? language : null;
  if (runtime === null || (await installHooksPresent({ ctx, cwd: null }))) {
    return null;
  }
  const detail = { reason: SANDBOX_RUN_CODE_REASON, reason_detail: 'Ran code in the sandbox.' };
  if (code !== null) {
    return scriptLoadsOnlyStandardCode({ runtime, source: code }) ? detail : null;
  }
  if (scriptPath === null) {
    return null;
  }
  // script_path resolves against the workspace; a script Aman did not write this session keeps its card.
  const identity = canonicalFileIdentity({
    p: scriptPath,
    cwd: resolveIdentityCwd(ctx, null),
    resolution: ctx.path_resolution,
  });
  if (
    identity === null ||
    !ctx.services.tracked_store.isTracked({ scope: workspaceScope(ctx), file_identity: identity })
  ) {
    return null;
  }
  return scriptFileLoadsOnlyStandardCode({ runtime, file: identity, resolution: ctx.path_resolution }) ? detail : null;
}

async function classifyExecShell(action: SentinelAction, ctx: ClassifyContext): Promise<TierDecision> {
  const { services } = ctx;
  const command = stringParam(action.canonical_params, 'command') ?? '';
  const cwd = stringParam(action.canonical_params, 'cwd');
  const env = envOverrides(action.canonical_params);
  const offline = await services.isOffline({ tenant_id: ctx.tenant_id, created_by: ctx.created_by });
  const sandboxSilent = await services.sandboxWithoutAsking({ tenant_id: ctx.tenant_id, created_by: ctx.created_by });

  // Agent-controlled env vars (e.g. LD_PRELOAD, PYTHONPATH, NODE_OPTIONS)
  // can inject code into allowlisted commands: escalate for approval.
  if (env !== null && Object.keys(env).length > 0) {
    return tier3Decision({
      card: {
        plain_what: `Run \`${escapeDisplayText(command)}\` with custom environment variables.`,
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
        reason_detail:
          parsed !== undefined && isPackageInstallArgv(parsed.argv)
            ? 'Installing packages needs downloads, which are off while offline.'
            : 'This shell command is not in the offline subset.',
        sensitive_read: false,
      });
    }
    // An allowed offline command continues to the same containment checks as online.
  }

  // With the user's switch on, a run of a script Aman wrote in this conversation is placed here and skips
  // the card. The containment checks below still apply to it.
  const parsed = parseSimpleCommand(command);
  const silentRun = sandboxSilent ? await sandboxRunPlacement({ command, parsed, ctx, cwd }) : null;

  // Write-then-execute check BEFORE allowlist matching. Scan every segment
  // of a compound command (`;`, `&&`, `||`, `|`): a tracked script hidden
  // behind a separator (e.g. `echo ok; sh payload.sh`) must not bypass this.
  // An in-sandbox run is exempt: the workspace and sandbox-folder limits above it still hold.
  const segments = silentRun === null ? splitCompoundSegments(command) : [];
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
          plain_what: `Execute \`${escapeDisplayText(basenameOf(executedOperand))}\`, which the server cannot resolve to a workspace file.`,
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
            plain_what: `Execute \`${escapeDisplayText(basenameOf(identity))}\`, a script the agent wrote earlier.`,
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
    const run =
      matched !== undefined
        ? { reason: 'shell_allowlist', reason_detail: `Ran allowlisted command \`${parsed.argv[0] ?? command}\`.` }
        : silentRun;
    if (run !== null) {
      const identityCwd = resolveIdentityCwd(ctx, cwd);
      // The cwd and every file operand must resolve inside the workspace.
      // An agent-controlled cwd or a symlink escape must not run silently.
      const workspaceRoot = ctx.workspace_cwd;
      if (workspaceRoot === null) {
        // Without a workspace there is nothing to contain the command in, so it must ask.
        return tier3Decision({
          card: {
            plain_what: `Run \`${escapeDisplayText(command)}\` where no workspace is set.`,
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
            plain_what: `Run \`${escapeDisplayText(command)}\` from outside the workspace.`,
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
            plain_what: `Access a file outside the workspace with \`${escapeDisplayText(command)}\`.`,
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
      // Every allowlist entry is read-only by curation (no writes, no network), and an in-sandbox
      // run is contained by the same checks. Anything that failed them asked instead.
      return tier1Decision({
        reason: run.reason,
        reason_detail: run.reason_detail,
        sensitive_read: containsSecretPath(action.canonical_params),
      });
    }
  }

  // Reads joined into one list, such as `cd repo && sed -n '5,9p' README.md`, run like each read would on its own.
  const list = parsed === undefined ? parseReadOnlyList({ command, config: services.shell_allowlist }) : undefined;
  if (
    list !== undefined &&
    ctx.workspace_cwd !== null &&
    isInsideWorkspace({
      p: resolveIdentityCwd(ctx, cwd),
      cwd: '/',
      workspace_root: ctx.workspace_cwd,
      resolution: ctx.path_resolution,
    }) &&
    readOnlyListInsideWorkspace({
      list,
      cwd: resolveIdentityCwd(ctx, cwd),
      workspace_root: ctx.workspace_cwd,
      resolution: ctx.path_resolution,
    })
  ) {
    return tier1Decision({
      reason: 'shell_read_only_list',
      reason_detail: 'Ran a list of read-only commands inside the workspace.',
      sensitive_read: containsSecretPath(action.canonical_params),
    });
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
          : `Run \`${escapeDisplayText(form.argv[0] ?? command)}\` with arguments the safe list does not allow.`,
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
    sensitive_read: containsSecretPath(action.canonical_params),
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

function writeCard(input: { plain_what: string; cannot_be_undone: string; ctx: ClassifyContext }): Tier3Card {
  return {
    plain_what: input.plain_what,
    plain_why: plainWhy(input.ctx.agent_intent),
    cannot_be_undone: input.cannot_be_undone,
    why_asked_again: null,
    destination: null,
    recipient: null,
    amount: null,
    parsed_command: null,
    outbound_text: null,
    destination_host: null,
    outbound_truncated: false,
  };
}

/** The files a sandbox write changes, as the paths to resolve against `cwd`; null when they cannot be determined. */
function sandboxWriteTargets(input: {
  action: SentinelAction;
  ctx: ClassifyContext;
  identityCwd: string;
}): { paths: string[]; cwd: string } | null {
  const { action, ctx } = input;
  if (ctx.workspace_cwd === null) {
    return null;
  }
  if (action.tool_name === 'apply_patch') {
    const targets = applyPatchTargets({
      params: action.canonical_params,
      workspace_root: ctx.workspace_cwd,
      cwd: input.identityCwd,
    });
    // Patch targets are workspace-relative whatever the call's cwd is.
    return targets.status === 'valid' ? { paths: targets.paths, cwd: ctx.workspace_cwd } : null;
  }
  const target = stringParam(action.canonical_params, 'path') ?? stringParam(action.canonical_params, 'target');
  // Relative targets resolve against the call's cwd, matching dispatch.
  return target === null ? null : { paths: [target], cwd: input.identityCwd };
}

const MAX_NAMED_WRITE_TARGETS = 5;

function namedWriteTargets(paths: readonly string[]): string {
  const shown = paths.slice(0, MAX_NAMED_WRITE_TARGETS).map(target => `\`${escapeDisplayText(target)}\``);
  const hidden = paths.length - shown.length;
  return hidden > 0 ? `${shown.join(', ')} and ${String(hidden)} more` : shown.join(', ');
}

/** A write target a silent write may touch: a file Aman created in this conversation, or a path that does not exist yet. */
function silentWriteTarget(input: { p: string; cwd: string; ctx: ClassifyContext }): boolean {
  const { p, cwd, ctx } = input;
  const identity = canonicalWriteIdentity({ p, cwd, resolution: ctx.path_resolution });
  if (
    identity !== null &&
    ctx.services.tracked_store.isTracked({ scope: workspaceScope(ctx), file_identity: identity })
  ) {
    return true;
  }
  return isNewWriteTarget({ p, cwd, resolution: ctx.path_resolution });
}

async function classifySandboxWrite(action: SentinelAction, ctx: ClassifyContext): Promise<TierDecision> {
  const identityCwd = resolveIdentityCwd(ctx, stringParam(action.canonical_params, 'cwd'));
  const targets = sandboxWriteTargets({ action, ctx, identityCwd });
  const outsideWorkspace = async (input: { plain_what: string; reason_detail: string }): Promise<TierDecision> =>
    tier3Decision({
      card: writeCard({
        ctx,
        plain_what: input.plain_what,
        cannot_be_undone: 'This file will be saved outside your workspace.',
      }),
      reason: 'write_outside_workspace',
      reason_detail: input.reason_detail,
      sensitive_read: false,
      approval_token_id: await mintPlainToken({
        ctx,
        tool_name: action.tool_name,
        params: action.canonical_params,
      }),
    });
  // Fail closed on undeterminable targets or a missing workspace: treat as outside workspace.
  if (targets === null || ctx.workspace_cwd === null) {
    return outsideWorkspace({
      plain_what: 'Write a file outside the workspace.',
      reason_detail: 'Write target is null or workspace is unknown.',
    });
  }
  const workspaceRoot = ctx.workspace_cwd;
  const absolute = targets.paths.map(target =>
    action.tool_name === 'apply_patch'
      ? absolutePatchTarget({ workspace_root: workspaceRoot, relative_path: target, resolution: ctx.path_resolution })
      : target,
  );
  // A new file resolves through its parent directory; an existing one, or a link, through its own
  // symlinks, so a link whose destination is outside the workspace is seen where it lands.
  const insideWorkspace = (target: string): boolean => {
    const identity = canonicalWriteIdentity({ p: target, cwd: targets.cwd, resolution: ctx.path_resolution });
    if (identity === null) {
      return false;
    }
    if (ctx.path_resolution === 'remote') {
      const root = lexicalPath({ p: workspaceRoot, cwd: '/' });
      return root !== null && isUnderRoot({ identity, root, separator: '/' });
    }
    try {
      const root = realpathSync(workspaceRoot);
      return identity === root || identity.startsWith(`${root}${path.sep}`);
    } catch {
      return false;
    }
  };
  const outside = targets.paths.filter((_, index) => !insideWorkspace(absolute[index] ?? ''));
  if (outside.length > 0) {
    return outsideWorkspace({
      plain_what: `Write a file outside the workspace at ${namedWriteTargets(outside)}.`,
      reason_detail: 'Write targets outside the workspace are never Tier 2.',
    });
  }
  // Git control files can make later allowlisted git commands run code.
  const controlTargets = targets.paths.filter((_, index) =>
    writeTargetTouchesGitControl({ p: absolute[index] ?? '', cwd: targets.cwd, resolution: ctx.path_resolution }),
  );
  if (controlTargets.length > 0) {
    return tier3Decision({
      card: writeCard({
        ctx,
        plain_what: `Write Git control file ${namedWriteTargets(controlTargets)}.`,
        cannot_be_undone: 'Git settings can make Git run other programs.',
      }),
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
  const toolTargets = targets.paths.filter((_, index) =>
    writeTargetTouchesSandboxTools({
      p: absolute[index] ?? '',
      cwd: targets.cwd,
      roots: [workspaceRoot],
      resolution: ctx.path_resolution,
    }),
  );
  if (toolTargets.length > 0) {
    return tier3Decision({
      card: writeCard({
        ctx,
        plain_what: `Save ${namedWriteTargets(toolTargets)} in a folder where this workspace keeps programs it can run.`,
        cannot_be_undone:
          'A program saved here could run instead of a trusted one. Approve only if you asked for this file.',
      }),
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
  // A write that stayed inside the workspace and missed every limit above runs silently when the user lets it.
  // Only a new file, or one Aman created in this conversation, may do so: an edit to an existing file asks.
  const everyTargetIsSilentlyWritable = absolute.every(target =>
    silentWriteTarget({ p: target, cwd: targets.cwd, ctx }),
  );
  if (
    everyTargetIsSilentlyWritable &&
    (await ctx.services.sandboxWithoutAsking({ tenant_id: ctx.tenant_id, created_by: ctx.created_by }))
  ) {
    return tier1Decision({
      reason: SANDBOX_FILE_WRITE_REASON,
      reason_detail: `Changed ${namedWriteTargets(targets.paths)} in your workspace.`,
      sensitive_read: targets.paths.some(namesSecretPath),
    });
  }
  return decideTier2({
    ctx,
    action,
    kind: 'file_write',
    plain_what: `Change ${namedWriteTargets(targets.paths)} in your workspace.`,
    parsed_command: null,
    reason: 'sandbox_write',
    reason_detail: `Sandbox file write to ${namedWriteTargets(targets.paths)}.`,
    sensitive_read: targets.paths.some(namesSecretPath),
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
  return `Perform an external action (${escapeDisplayText(input.tool_name)}) affecting ${where}.`;
}

const DESTRUCTIVE_FRAGMENTS = ['delete', 'remove', 'uninstall', 'drop', 'destroy', 'erase'];
const INSTALL_FRAGMENTS = ['install'];

/** Stands in for a query text when a key could not be masked inside it. */
const HIDDEN_QUERY = '(hidden)';

/** Most characters of query text an approval card shows. */
const SEARCH_CARD_TEXT_MAX = 1000;

/** The query texts joined for one line. Callers pass only what a person reads, never provider plumbing. */
function searchQueryText(texts: readonly string[]): string {
  return texts
    .map(value => value.trim())
    .filter(value => value !== '')
    .join(' | ');
}

/**
 * The one line a held search card names: the first text the search carries, such as its objective or
 * first query. Provider plumbing and the other fields stay out; the exact text is in the card's details.
 */
function searchSummaryText(strings: OutboundStrings): string {
  return strings.values.map(value => value.trim()).find(value => value !== '') ?? '';
}

/**
 * The outbound secret guard over the text a silent call would send. The search provider and embedded
 * maps both run it, so both stop on the same things: a held key, and text the guard cannot read.
 */
async function outboundGuard(input: {
  ctx: ClassifyContext;
  strings: OutboundStrings | undefined;
}): Promise<{ secrets: readonly string[]; verdict: OutboundGuardVerdict }> {
  const { ctx, strings } = input;
  const secrets = await ctx.services.outboundSecrets({ tenant_id: ctx.tenant_id, created_by: ctx.created_by });
  const verdict: OutboundGuardVerdict =
    strings === undefined
      ? { ok: false, rule: 'uninspectable' }
      : checkOutboundStrings({ strings, secrets, earlier: ctx.web_search.sentText });
  return { secrets, verdict };
}

/**
 * The search service's own plumbing lines of a held search's card. The card's "Exactly what will be sent" still
 * lists every argument; these lines are also named here so the card can fold them behind a Details disclosure.
 */
function searchPlumbingText(input: {
  params: Record<string, unknown> | undefined;
  plumbingFields: readonly string[];
}): string | null {
  if (input.params === undefined) {
    return null;
  }
  const plumbing = new Set(input.plumbingFields);
  const hidden: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input.params)) {
    if (plumbing.has(key)) {
      hidden[key] = value;
    }
  }
  return renderOutboundArguments(hidden).text;
}

/**
 * A designated-provider call that stops for approval. The card shows the exact text the call would
 * send. An unattended run holds it for the owner like any other call that asks.
 */
async function holdSearchCall(input: {
  action: SentinelAction;
  ctx: ClassifyContext;
  reason: SearchAskReason;
  /** The one sentence that says why the assistant is asking. */
  say: string;
  /** The card's one line, with any held key masked. */
  summary: string;
  /** True when the call opens a page rather than searches, so the card says so. */
  page: boolean;
  /** Arguments the card may quote, with any held key masked; undefined when they cannot be shown. */
  params: Record<string, unknown> | undefined;
  fields: ExtractionResult['fields'];
}): Promise<TierDecision> {
  const { action, ctx, fields } = input;
  const shown =
    input.summary.length > SEARCH_CARD_TEXT_MAX ? `${input.summary.slice(0, SEARCH_CARD_TEXT_MAX)}...` : input.summary;
  const provider = searchProviderLabel({ host: action.mcp_server_host });
  const tavilyText =
    input.params === undefined
      ? null
      : tavilyApprovalWhat({
          server_host: action.mcp_server_host,
          tool_name: action.tool_name,
          canonical_params: input.params,
          max_chars: SEARCH_CARD_TEXT_MAX,
        });
  const tavily = tavilyText === null ? null : escapeDisplayText(tavilyText);
  const decision = tier3Decision({
    card: {
      plain_what:
        tavily === null
          ? searchHoldCardText({ summary: escapeDisplayText(shown), say: input.say, page: input.page })
          : withHoldSay(tavily, input.say),
      plain_why: plainWhy(ctx.agent_intent),
      cannot_be_undone: null,
      why_asked_again: null,
      // The connector id is never shown; "Sends to" carries the provider's brand instead.
      destination: null,
      recipient: null,
      amount: null,
      parsed_command: null,
      outbound_text: fields.outbound_text,
      outbound_plumbing_text: searchPlumbingText({
        params: input.params,
        plumbingFields: action.mcp_search_plumbing_fields ?? [],
      }),
      // The card's "Sends to" line names the provider, not the host it is reached on.
      destination_host: provider ?? SEARCH_SERVER_FALLBACK,
      outbound_truncated: fields.outbound_truncated,
    },
    reason: input.reason,
    reason_detail: input.say,
    sensitive_read: false,
    approval_token_id: await mintPlainToken({
      ctx,
      tool_name: action.tool_name,
      params: action.canonical_params,
      connector: connectorBindingFor(action),
    }),
  });
  return {
    ...decision,
    audit_description: searchHoldAuditText({ server: SEARCH_SERVER_FALLBACK, say: input.say, page: input.page }),
  };
}

/**
 * The designated search provider's call: a search or a page read. Runs without asking unless the person switched
 * searches to ask, the outbound secret guard trips, the turn already ran its allowance of silent lookups, or content
 * the assistant read chose the link and the call adds to it. Returns undefined, leaving the call to the ordinary
 * rules, for a tool that the server did not declare read-only and the host's list does not name as a search tool,
 * that declares itself destructive or not read-only, falls in a name-based escalation class, or touches a sensitive
 * path: the role never lowers those, so designating a connector that can write does not make its unannotated tools
 * silent.
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
    containsSecretPath(action.canonical_params)
  ) {
    return undefined;
  }
  const owner = { tenant_id: ctx.tenant_id, created_by: ctx.created_by };
  const say = holdSay(ctx.web_search.assistantName);
  const strings = collectOutboundStrings(action.canonical_params, action.mcp_search_plumbing_fields);
  const queryText = strings === undefined ? '' : searchQueryText(strings.values);
  const summary = strings === undefined ? '' : searchSummaryText(strings);
  const sentValues = strings === undefined ? [] : [...strings.values, ...strings.plumbing];
  const page = namesUrl(sentValues);
  const held = (reason: SearchAskReason, reasonSay: string): Promise<TierDecision> =>
    holdSearchCall({
      action,
      ctx,
      reason,
      say: reasonSay,
      summary,
      page,
      params: action.canonical_params,
      fields: extraction.fields,
    });
  // The card, the stored turn and the audit row never carry a key this computer holds.
  const heldWithoutKey = async (secrets: readonly string[]): Promise<TierDecision> => {
    const masked = maskServerSecrets({
      params: action.canonical_params,
      secrets,
      earlier: ctx.web_search.sentText,
      plumbingFields: action.mcp_search_plumbing_fields,
    });
    const maskedStrings =
      masked === undefined ? undefined : collectOutboundStrings(masked, action.mcp_search_plumbing_fields);
    const outbound = masked === undefined ? undefined : renderOutboundArguments(masked);
    return holdSearchCall({
      action,
      ctx,
      reason: 'mcp_search_guard',
      say: SECRET_SAY,
      summary: maskedStrings === undefined ? HIDDEN_QUERY : searchSummaryText(maskedStrings),
      page,
      params: masked,
      fields: {
        ...extraction.fields,
        outbound_text: outbound === undefined ? `query: ${HIDDEN_QUERY}` : outbound.text,
        outbound_truncated: outbound?.truncated ?? false,
      },
    });
  };

  // A held key is masked whether or not searches are set to ask.
  const { secrets, verdict } = await outboundGuard({ ctx, strings });
  if (!verdict.ok && verdict.rule === 'server_secret') {
    return heldWithoutKey(secrets);
  }
  if (!(await ctx.services.searchWithoutAsking(owner))) {
    return held('mcp_search_setting_ask', say.search_setting);
  }
  if (!verdict.ok) {
    return held('mcp_search_guard', guardRuleSay({ rule: verdict.rule, assistant: ctx.web_search.assistantName }));
  }
  // A loop breaker, not a question: the reply stops looking things up and the person is told in one line.
  if (ctx.web_search.silentSearches >= SILENT_SEARCH_LIMIT) {
    return autoDenyDecision({
      reason: 'lookup_limit',
      reason_detail: say.search_limit,
      owner_message: say.search_limit,
      sensitive_read: false,
    });
  }
  if (steeredLinks({ provenance: ctx.web_search.provenance, values: sentValues }).length > 0) {
    return ctx.services.unattended ? steeredSkipped(ctx) : held(SEARCH_STEERED_REASON, say.steered);
  }
  return tier1Decision({
    reason: SEARCH_SILENT_REASON,
    reason_detail: `${page ? 'Opened' : 'Searched'}: ${queryText}`,
    sensitive_read: false,
    silent_search_query: queryText,
  });
}

/** A held call that is skipped rather than asked, for a scheduled run with nobody to answer. */
function steeredSkipped(ctx: ClassifyContext): TierDecision {
  const assistant = ctx.web_search.assistantName;
  return autoDenyDecision({
    reason: 'steered_by_content',
    reason_detail: `A link or address in something ${assistant} read chose this, not you.`,
    owner_message: `One step was skipped, because something ${assistant} read asked for it, not you.`,
    sensitive_read: false,
  });
}

/**
 * A consequential action asks with its card as it is. When a recipient or site the card names came only from content
 * the assistant read, the card says so and no chat grant covers it; a scheduled run skips it. `guests` adds people
 * the card holds only as text, such as a shared calendar's guests.
 */
function steeringChecked(input: {
  decision: TierDecision;
  ctx: ClassifyContext;
  guests: readonly string[];
}): TierDecision {
  const { decision, ctx } = input;
  const card = decision.card;
  if (decision.tier !== 3 || decision.auto_deny !== null || card === null) {
    return decision;
  }
  const mail = card.email ?? null;
  const steered = steeredDestinations({
    provenance: ctx.web_search.provenance,
    addresses: mail === null ? [] : [...mail.to, ...mail.cc, ...mail.bcc].map(mailbox => mailbox.address),
    // The connector's own configured host is the person's setup, not something read content could choose.
    values: [
      ...[card.recipient, card.destination].filter(value => value !== null),
      ...(card.calendar_event?.attendees ?? []),
      ...input.guests,
    ],
    // Only the host-read sender of the one message this replies to; never the model's or the message's own claim.
    reply_sender: mail?.reply_in_thread?.from ?? null,
  });
  if (steered.length === 0) {
    return decision;
  }
  if (ctx.services.unattended) {
    return steeredSkipped(ctx);
  }
  const cardNames = new Map(
    (mail === null ? [] : [...mail.to, ...mail.cc, ...mail.bcc]).map(mailbox => [
      mailbox.address.toLowerCase(),
      mailbox.name,
    ]),
  );
  const say = steeredDestinationSay({
    assistant: ctx.web_search.assistantName,
    destinations: steered.map(({ value, kind, origin }) => {
      // The name the send itself shows wins; an email's sender name fills in when the card has none.
      const cardName = kind === 'address' ? (cardNames.get(value.toLowerCase()) ?? '') : '';
      const name = cardName === '' ? (kind === 'address' ? origin.name : null) : cardName;
      const shown = escapeDisplayText(value);
      return { kind, source: origin.source, who: name === null ? shown : `${escapeDisplayText(name)} (${shown})` };
    }),
  });
  return {
    ...decision,
    reason: CONTENT_STEERED_REASON,
    reason_detail: say,
    card: { ...card, plain_what: withHoldSay(card.plain_what, say) },
  };
}

/**
 * An embedded maps call that runs without asking, once the person has let maps run without asking. The outbound
 * secret guard still reads its places. Returns the guard's rule when the call should show its card instead.
 */
async function classifyMapsSilently(input: {
  action: SentinelAction;
  ctx: ClassifyContext;
}): Promise<{ decision: TierDecision } | { held: OutboundGuardVerdict }> {
  const { action, ctx } = input;
  const strings = collectOutboundStrings(action.canonical_params);
  const { verdict } = await outboundGuard({ ctx, strings });
  if (!verdict.ok) {
    return { held: verdict };
  }
  // The text leaves with this call, so a later silent search or map sees a secret split across the two.
  if (strings !== undefined) {
    ctx.web_search.sentText = appendOutboundTrace({ earlier: ctx.web_search.sentText, strings });
  }
  const values = strings?.values.map(value => value.trim()).filter(value => value !== '') ?? [];
  return {
    decision: tier1Decision({
      reason: MAPS_SILENT_REASON,
      reason_detail: `Maps ran without asking: ${values.join(', ')}`,
      sensitive_read: false,
    }),
  };
}

/** Said on a card when a recipient's name was left off because it looked like an address. */
const NAME_LEFT_OFF_LINE = ' The name was left off this address because it looked like an address.';

/** Most characters of subject the card shows inside its sentence. */
const GMAIL_CARD_SUBJECT_MAX_CHARS = 80;

/** One recipient as `Name (address)`, or the bare address when it has no name, so the address is always shown. */
/** Already-escaped items in a sentence: `A, B and C`. */
function joinSentence(shown: readonly string[]): string {
  if (shown.length <= 1) {
    return shown.join('');
  }
  return `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1] ?? ''}`;
}

function displayList(addresses: readonly string[]): string {
  return joinSentence(addresses.map(address => escapeDisplayText(address)));
}

function recipientList(recipients: readonly Tier3Mailbox[]): string {
  return joinSentence(recipients.map(mailbox => mailboxText(mailbox, { escape: escapeDisplayText })));
}

/** A recipient for the structured email block: its name and address, each escaped as the card escapes text. */
function escapedMailbox(mailbox: Tier3Mailbox): Tier3Mailbox {
  return { name: escapeDisplayText(mailbox.name), address: escapeDisplayText(mailbox.address) };
}

function cardText(text: string): string {
  const chars = Array.from(escapeDisplayText(text));
  return chars.length > GMAIL_CARD_SUBJECT_MAX_CHARS
    ? `${chars.slice(0, GMAIL_CARD_SUBJECT_MAX_CHARS - 1).join('')}…`
    : chars.join('');
}

function cardSubject(subject: string): string {
  return `"${cardText(subject).replace(/"/g, '\\"')}"`;
}

/**
 * The approval card for a Gmail write, built from the message as the host holds it (the draft Gmail stores
 * for a send, the content the call will write for a draft), never from model prose. The whole message is on
 * the card, uncut, so what is approved is everything that is sent. Null when the message was not supplied.
 */
function gmailWriteCard(input: { action: SentinelAction; agent_intent: string | null }): Tier3Card | null {
  const { action } = input;
  const content = action.mail_draft;
  if (content === undefined) {
    return null;
  }
  const kind =
    action.tool_name === SEND_DRAFT_TOOL_NAME
      ? 'send'
      : action.tool_name === UPDATE_DRAFT_TOOL_NAME
        ? 'change'
        : 'save';
  const parts = [
    `to ${recipientList(content.to) === '' ? 'no one' : recipientList(content.to)}`,
    ...(content.cc.length > 0 ? [`Copy: ${recipientList(content.cc)}`] : []),
    ...(content.bcc.length > 0 ? [`Hidden copy: ${recipientList(content.bcc)}`] : []),
    ...(content.replyTo === null ? [] : [`Replies go to: ${escapeDisplayText(content.replyTo)}`]),
  ];
  const subject = cardSubject(content.subject);
  const replaces = action.mail_replaces;
  const recipientsLine = [
    ...parts,
    ...(content.fromName === ''
      ? []
      : [`Sent as "${escapeDisplayText(content.fromName).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`]),
  ].join('. ');
  const answered = action.mail_reply_in_thread;
  const threadLine =
    answered === undefined
      ? ''
      : ` Reply in the thread: ${cardSubject(answered.subject)}, from ${cardText(answered.from)}.`;
  const plainWhat =
    (kind === 'send'
      ? `Send ${subject} from your Gmail ${recipientsLine}.`
      : kind === 'change'
        ? `Change a saved draft in your Gmail. It replaces ${replaces === undefined ? 'the saved draft' : `${cardSubject(replaces.subject)} to ${recipientList(replaces.to) === '' ? 'no one' : recipientList(replaces.to)}`} with ${subject} ${recipientsLine}. It is not sent.`
        : `Save a draft ${subject} in your Gmail ${recipientsLine}. It is not sent.`) +
    threadLine +
    (content.nameLeftOff || replaces?.nameLeftOff === true ? NAME_LEFT_OFF_LINE : '');
  return {
    plain_what: plainWhat,
    plain_why: plainWhy(input.agent_intent),
    cannot_be_undone: kind === 'send' ? "Once this is sent, it can't be unsent." : null,
    why_asked_again: null,
    destination: null,
    recipient: null,
    amount: null,
    parsed_command: null,
    outbound_text: null,
    destination_host: null,
    outbound_truncated: false,
    email: {
      action: kind,
      to: content.to.map(escapedMailbox),
      cc: content.cc.map(escapedMailbox),
      bcc: content.bcc.map(escapedMailbox),
      subject: escapeDisplayText(content.subject),
      body: escapeDisplayText(content.body, { keepNewlines: true }),
      reply_to: content.replyTo === null ? null : escapeDisplayText(content.replyTo),
      replaces:
        replaces === undefined
          ? null
          : {
              subject: escapeDisplayText(replaces.subject),
              to: replaces.to.map(escapedMailbox),
            },
      reply_in_thread:
        answered === undefined
          ? null
          : { subject: escapeDisplayText(answered.subject), from: escapeDisplayText(answered.from) },
    },
  };
}

function demoRefusal(reason_detail: string): TierDecision {
  return autoDenyDecision({ reason: 'outbound_guard', reason_detail, sensitive_read: false });
}

/** The addresses a mail send would reach that are not on the Email list; empty for any other call. */
async function mailNewRecipients(input: { action: SentinelAction; ctx: ClassifyContext }): Promise<string[]> {
  const { action, ctx } = input;
  if (
    action.tool_type !== 'mcp' ||
    !isMailSend({ mcp_server_name: action.mcp_server_name, tool_name: action.tool_name })
  ) {
    return [];
  }
  return mailRecipientsNotListed({
    listed: await ctx.services.mail_listed_addresses({ tenant_id: ctx.tenant_id, created_by: ctx.created_by }),
    params: action.canonical_params,
  });
}

/**
 * A connector's tool name and arguments do not reliably show whether it sends mail, so a demo instance refuses
 * a connector call that could send. Any other call is refused unless it is declared read-only or is a read by
 * name. Only Aman's own Gmail tools check recipients.
 */
function demoRefusesConnector(input: {
  action: SentinelAction;
  ctx: ClassifyContext;
  extraction: ExtractionResult;
}): boolean {
  return (
    input.ctx.services.demoSendAllowlist !== null &&
    input.action.tool_type === 'mcp' &&
    (input.extraction.sends || (input.action.mcp_hints.read_only_hint !== true && !input.extraction.connector_read))
  );
}

/**
 * A read of the operator's own Email sidecar runs without a card, as Gmail's reads do. It is a private read, so a
 * web search later in the chat asks first. Only the host-vouched first-party connector gets this, never a user's
 * connector that happens to be named Email.
 */
async function classifyMailRead(action: SentinelAction, ctx: ClassifyContext): Promise<TierDecision> {
  if (await ctx.services.isOffline({ tenant_id: ctx.tenant_id, created_by: ctx.created_by })) {
    return autoDenyDecision({
      reason: 'offline_mode',
      reason_detail: 'Email needs network access, which is disabled while offline.',
      sensitive_read: false,
    });
  }
  return tier1Decision({
    reason: MAIL_READ_REASON,
    reason_detail: `Read your email with \`${action.tool_name}\`.`,
    sensitive_read: true,
  });
}

/**
 * Gmail tools are the host's own, named by server so a connector's tool of the same name never takes this
 * path. Reads are silent but flagged as sensitive, and a session that read mail can no longer search silently.
 */
async function classifyGmailTool(action: SentinelAction, ctx: ClassifyContext): Promise<TierDecision> {
  if (await ctx.services.isOffline({ tenant_id: ctx.tenant_id, created_by: ctx.created_by })) {
    return autoDenyDecision({
      reason: 'offline_mode',
      reason_detail: 'Gmail needs network access, which is disabled while offline.',
      sensitive_read: false,
    });
  }
  if (isGmailReadToolName(action.tool_name)) {
    return tier1Decision({
      reason: 'gmail_read',
      reason_detail: 'Read your email.',
      sensitive_read: true,
    });
  }
  if (!isGmailWriteToolName(action.tool_name)) {
    return failClosedDecision({ reason_detail: 'Unknown Gmail tool.' });
  }
  if (ctx.services.unattended) {
    return autoDenyDecision({
      reason: 'unattended_run',
      reason_detail: 'Scheduled runs can read your email but never draft or send it.',
      sensitive_read: false,
    });
  }
  const draft = action.mail_draft;
  if (
    action.tool_name === SEND_DRAFT_TOOL_NAME &&
    ctx.services.demoSendAllowlist !== null &&
    (draft === undefined ||
      !recipientsAllowed({
        allowlist: ctx.services.demoSendAllowlist,
        recipients: [...draft.to, ...draft.cc, ...draft.bcc].map(mailbox => mailbox.address),
      }))
  ) {
    return demoRefusal(DEMO_SEND_REFUSAL);
  }
  const card = gmailWriteCard({ action, agent_intent: ctx.agent_intent });
  if (card === null) {
    return autoDenyDecision({
      reason: 'destination_unverifiable',
      reason_detail: 'The message could not be loaded to show you, so it was not offered.',
      sensitive_read: false,
    });
  }
  const isSend = action.tool_name === SEND_DRAFT_TOOL_NAME;
  return tier3Decision({
    card,
    reason: isSend ? 'gmail_send' : 'gmail_draft',
    reason_detail: isSend ? 'Sending email always asks.' : 'Saving a draft always asks.',
    sensitive_read: false,
    approval_token_id: await mintPlainToken({ ctx, tool_name: action.tool_name, params: action.canonical_params }),
  });
}

/**
 * The approval card for a Calendar write, built from the request the host will send, never from model prose.
 * Every guest is listed, and whether Google emails them is said in words.
 */
function calendarWriteCard(input: {
  review: CalendarWriteReview;
  agent_intent: string | null;
  assistant: string;
}): Tier3Card {
  const { review, assistant } = input;
  const show = (text: string) => escapeDisplayText(text);
  const title = cardSubject(review.title);
  const guests = displayList(review.attendees);
  const guestLine =
    review.attendees.length === 0
      ? ''
      : review.guests_emailed
        ? ` Google emails ${guests} about it.`
        : ` Guests: ${guests}. Google does not email them.`;
  // An event that runs over more than one day is often a broken end date, so the card asks.
  const spanWarning =
    review.span_days > 1 ? ` This event runs over ${String(review.span_days)} days. Is that right?` : '';
  // The same event was already created in this chat in the last few minutes: ask before adding another.
  const duplicateLead =
    review.action === 'create' && review.already_created ? 'You already have this event. Add another? ' : '';
  const plainWhat =
    review.action === 'create'
      ? `${duplicateLead}Add ${title} to your Google Calendar on ${show(review.short_when)} (${show(review.time_zone)}).${guestLine}${spanWarning}`
      : `Change ${review.before === null ? 'an event' : cardSubject(review.before.title)}${review.one_of_repeating ? ' (this one event of a repeating series)' : ''} in your Google Calendar to ${title} on ${show(review.short_when)} (${show(review.time_zone)}).${guestLine}${spanWarning}`;
  // Says why a guest change asks every time: neither a standing nor a chat-wide answer covers it.
  const alwaysAsks =
    review.attendees.length === 0
      ? ''
      : review.action === 'create'
        ? ` This change sends an invitation to other people, so ${assistant} always asks.`
        : ` This change reaches the other people invited to this event, so ${assistant} always asks.`;
  return {
    plain_what: `${plainWhat}${alwaysAsks}`,
    plain_why: plainWhy(input.agent_intent),
    cannot_be_undone: review.guests_emailed ? "Google emails the guests right away. That email can't be unsent." : null,
    why_asked_again: null,
    destination: null,
    recipient: null,
    amount: null,
    parsed_command: null,
    outbound_text: null,
    destination_host: null,
    outbound_truncated: false,
    calendar_event: {
      action: review.action,
      calendar: show(review.calendar),
      title: show(review.title),
      when: show(review.short_when),
      time_zone: show(review.time_zone),
      duration: show(review.duration),
      location: show(review.location),
      description: escapeDisplayText(review.description, { keepNewlines: true }),
      attendees: review.attendees.map(show),
      guests_emailed: review.guests_emailed,
      one_of_repeating: review.one_of_repeating,
      before:
        review.before === null
          ? null
          : {
              title: show(review.before.title),
              when: show(review.before.short_when),
              duration: show(review.before.duration),
              location: show(review.before.location),
            },
    },
  };
}

/** Whether an "Always allow" grant covers this call's tool, looked up as a connector call's grant is. */
function hasStandingToolGrant(ctx: ClassifyContext, action: SentinelAction): Promise<boolean> {
  if (action.mcp_server_name === undefined) {
    return Promise.resolve(false);
  }
  return ctx.services.tool_grants.hasToolGrant({
    tenant_id: ctx.tenant_id,
    created_by: ctx.created_by,
    mcp_server_name: action.mcp_server_name,
    tool_name: action.tool_name,
    mcp_server_host: action.mcp_server_host ?? null,
  });
}

/**
 * Calendar tools are the host's own, named by server. A read is silent but flagged as sensitive (so a session that
 * read the calendar can no longer search silently). A write always asks with the event in full; in a scheduled run
 * that ask is held for the owner's OK instead of running. Any other name fails closed.
 */
async function classifyCalendarTool(action: SentinelAction, ctx: ClassifyContext): Promise<TierDecision> {
  if (await ctx.services.isOffline({ tenant_id: ctx.tenant_id, created_by: ctx.created_by })) {
    return autoDenyDecision({
      reason: 'offline_mode',
      reason_detail: 'Google Calendar needs network access, which is disabled while offline.',
      sensitive_read: false,
    });
  }
  if (isCalendarWriteToolName(action.tool_name)) {
    if (action.calendar_write === undefined) {
      return autoDenyDecision({
        reason: 'destination_unverifiable',
        reason_detail: 'The event could not be loaded to show you, so it was not offered.',
        sensitive_read: false,
      });
    }
    const review = action.calendar_write;
    // A guest is reached even without an email (Google adds invites to their calendar), so on a demo every guest
    // must be on the send list. An event with no guests reaches no one.
    if (
      review.attendees.length > 0 &&
      !recipientsAllowed({ allowlist: ctx.services.demoSendAllowlist, recipients: review.attendees })
    ) {
      return demoRefusal(DEMO_SEND_REFUSAL);
    }
    if (review.incomplete_reason !== null) {
      return autoDenyDecision({
        reason: 'incomplete_send_card',
        reason_detail: review.incomplete_reason,
        owner_message: 'Nothing was saved: the guests would get something the card could not show you.',
        sensitive_read: false,
      });
    }
    // Guests who are emailed get the event text, so it is a send and passes the same secret guard.
    if (review.guests_emailed) {
      const verdict = checkOutboundStrings({
        strings: { values: [review.title, review.description, review.location], scalars: [], keys: [], plumbing: [] },
        secrets: await ctx.services.outboundSecrets({ tenant_id: ctx.tenant_id, created_by: ctx.created_by }),
      });
      if (!verdict.ok) {
        return autoDenyDecision({
          reason: 'outbound_guard',
          reason_detail: `The event would be emailed to its guests, and ${describeOutboundRule(verdict.rule)}.`,
          sensitive_read: false,
        });
      }
    }
    // Only a change that reaches no guest can be covered by a standing grant; a guest change always asks.
    const reachesGuests = review.attendees.length > 0;
    if (!reachesGuests && (await hasStandingToolGrant(ctx, action))) {
      return tier1Decision({
        reason: TOOL_GRANT_REASON,
        reason_detail: `Always allowed: \`${action.tool_name}\` on your calendar.`,
        sensitive_read: false,
      });
    }
    return tier3Decision({
      card: calendarWriteCard({ review, agent_intent: ctx.agent_intent, assistant: ctx.web_search.assistantName }),
      reason: reachesGuests ? 'calendar_write_guests' : 'calendar_write',
      reason_detail: reachesGuests
        ? 'A calendar change that reaches guests always asks.'
        : 'Adding or changing an event on your own calendar asks.',
      sensitive_read: false,
      approval_token_id: await mintPlainToken({ ctx, tool_name: action.tool_name, params: action.canonical_params }),
    });
  }
  if (!isCalendarReadToolName(action.tool_name)) {
    return failClosedDecision({ reason_detail: 'Unknown calendar tool.' });
  }
  return tier1Decision({
    reason: 'calendar_read',
    reason_detail: 'Read your calendar.',
    sensitive_read: true,
  });
}

/** The approval card for creating or deleting a schedule, built from what the host will save or remove. */
function scheduleWriteCard(input: { review: Tier3Schedule; agent_intent: string | null }): Tier3Card {
  const { review } = input;
  const show = (text: string) => escapeDisplayText(text);
  const name = cardSubject(review.name);
  const when = `${show(review.when)} (${show(review.time_zone)})`;
  return {
    plain_what:
      review.action === 'create'
        ? `Create the schedule ${name}. It runs ${when.charAt(0).toLowerCase()}${when.slice(1)} and starts as soon as you approve.`
        : `Delete the schedule ${name}, which runs ${when.charAt(0).toLowerCase()}${when.slice(1)}.`,
    plain_why: plainWhy(input.agent_intent),
    cannot_be_undone: review.action === 'delete' ? 'Once deleted, the schedule is gone for good.' : null,
    why_asked_again: null,
    destination: null,
    recipient: null,
    amount: null,
    parsed_command: null,
    outbound_text: null,
    destination_host: null,
    outbound_truncated: false,
    schedule: {
      action: review.action,
      name: show(review.name),
      when: show(review.when),
      time_zone: show(review.time_zone),
      task: escapeDisplayText(review.task, { keepNewlines: true }),
      runs_as: show(review.runs_as),
      next_runs: review.next_runs.map(show),
    },
  };
}

/** The approval card for adding a persona, built from what the host will save. */
function personaWriteCard(input: { review: Tier3Persona; agent_intent: string | null }): Tier3Card {
  const { review } = input;
  const show = (text: string) => escapeDisplayText(text);
  // The description is shown as one sentence, so a trailing full stop is not doubled.
  const sentence = show(review.description).replace(/[.!?]+$/, '');
  return {
    plain_what: `Add a persona: ${show(review.name)}. ${sentence}.`,
    plain_why: plainWhy(input.agent_intent),
    cannot_be_undone: null,
    why_asked_again: null,
    destination: null,
    recipient: null,
    amount: null,
    parsed_command: null,
    outbound_text: null,
    destination_host: null,
    outbound_truncated: false,
    persona: {
      name: show(review.name),
      description: show(review.description),
      instructions: escapeDisplayText(review.instructions, { keepNewlines: true }),
      model_name: show(review.model_name),
    },
  };
}

/**
 * Adding a persona always asks with the full instructions. Reading the list and switching this chat to an
 * existing persona run without asking. Any other persona tool name fails closed.
 */
async function classifyPersonaTool(action: SentinelAction, ctx: ClassifyContext): Promise<TierDecision> {
  if (action.tool_name === LIST_PERSONAS_TOOL_NAME) {
    return tier1Decision({ reason: 'persona_read', reason_detail: 'Read your personas.', sensitive_read: false });
  }
  if (action.tool_name === USE_PERSONA_TOOL_NAME) {
    return tier1Decision({
      reason: 'persona_switch',
      reason_detail: 'Switch this chat to a persona you already have.',
      sensitive_read: false,
    });
  }
  if (!isPersonaWriteToolName(action.tool_name)) {
    return failClosedDecision({ reason_detail: 'Unknown persona tool.' });
  }
  if (action.persona_write === undefined) {
    return autoDenyDecision({
      reason: 'destination_unverifiable',
      reason_detail: 'The persona could not be checked, so it was not offered.',
      sensitive_read: false,
    });
  }
  return tier3Decision({
    card: personaWriteCard({ review: action.persona_write, agent_intent: ctx.agent_intent }),
    reason: 'persona_write',
    reason_detail: 'Adding a persona always asks.',
    sensitive_read: false,
    approval_token_id: await mintPlainToken({ ctx, tool_name: action.tool_name, params: action.canonical_params }),
  });
}

/**
 * Schedule tools are the host's own, named by server. Creating or deleting always asks with the schedule in full;
 * listing, pausing and resuming run without asking. Any other name fails closed.
 */
async function classifyScheduleTool(action: SentinelAction, ctx: ClassifyContext): Promise<TierDecision> {
  if (isScheduleWriteToolName(action.tool_name)) {
    if (action.schedule_write === undefined) {
      return autoDenyDecision({
        reason: 'destination_unverifiable',
        reason_detail: 'The schedule could not be loaded to show you, so it was not offered.',
        sensitive_read: false,
      });
    }
    return tier3Decision({
      card: scheduleWriteCard({ review: action.schedule_write, agent_intent: ctx.agent_intent }),
      reason: 'schedule_write',
      reason_detail: 'Creating or deleting a schedule always asks.',
      sensitive_read: false,
      approval_token_id: await mintPlainToken({ ctx, tool_name: action.tool_name, params: action.canonical_params }),
    });
  }
  if (isScheduleStatusToolName(action.tool_name)) {
    return tier1Decision({
      reason: 'schedule_status',
      reason_detail: 'Pause or resume a schedule.',
      sensitive_read: false,
    });
  }
  if (action.tool_name === LIST_SCHEDULES_TOOL_NAME) {
    return tier1Decision({ reason: 'schedule_read', reason_detail: 'Read your schedules.', sensitive_read: false });
  }
  return failClosedDecision({ reason_detail: 'Unknown schedule tool.' });
}

/**
 * Space tools are the host's own, named by server. Reading or writing one runs without asking: a space
 * is the person's own page on their own machine, nothing leaves it, and every write keeps a revision
 * that revert_space can restore. Any other name fails closed.
 */
function classifySpaceTool(action: SentinelAction): TierDecision {
  const line = spaceToolLine(action);
  if (line !== null && isSpaceWriteToolName(action.tool_name)) {
    return tier1Decision({ reason: 'space_write', reason_detail: line, sensitive_read: false });
  }
  if (line !== null && isSpaceReadToolName(action.tool_name)) {
    return tier1Decision({ reason: 'space_read', reason_detail: line, sensitive_read: false });
  }
  return failClosedDecision({ reason_detail: 'Unknown space tool.' });
}

/** Most characters of a space's name the line in the chat shows. */
const SPACE_NAME_MAX_CHARS = 80;

/**
 * The space's name as the line shows it: whitespace runs folded to one space, ends trimmed, made safe
 * to show, then capped the way the Gmail card caps a subject. Null when the call carries no name, or
 * the name is only whitespace, so the line falls back to naming no space.
 */
function spaceDisplayName(name: string | null): string | null {
  if (name === null) {
    return null;
  }
  const oneLine = name.replace(/\s+/g, ' ').trim();
  if (oneLine === '') {
    return null;
  }
  const chars = Array.from(escapeDisplayText(oneLine));
  return chars.length > SPACE_NAME_MAX_CHARS ? `${chars.slice(0, SPACE_NAME_MAX_CHARS - 1).join('')}…` : chars.join('');
}

/**
 * The plain line for a space tool, in the words the activity rail shows. A name is shown only when
 * the call carries one: get_space, list_blocks and revert_space name the space by id alone, so their
 * lines say "a space". Null for any tool that is not the host's own space tool.
 */
function spaceToolLine(action: SentinelAction): string | null {
  if (action.tool_type !== 'truefoundry-system' || action.mcp_server_name !== SPACE_SERVER_ID) {
    return null;
  }
  const name = spaceDisplayName(stringParam(action.canonical_params, 'name'));
  switch (action.tool_name) {
    case LIST_SPACES_TOOL_NAME:
      return 'Looked at your spaces.';
    case GET_SPACE_TOOL_NAME:
      return 'Read a space.';
    case LIST_BLOCKS_TOOL_NAME:
      return 'Looked at the sections of a space.';
    case CREATE_SPACE_TOOL_NAME:
      return name === null ? 'Created a space.' : `Created the space ${name}.`;
    case UPDATE_SPACE_TOOL_NAME:
      return name === null ? 'Updated a space.' : `Updated the space ${name}.`;
    case REVERT_SPACE_TOOL_NAME:
      return 'Restored an earlier version of a space.';
    default:
      return null;
  }
}

/**
 * The arguments a card shows: any server key the computer holds is masked, so no card carries it raw. The
 * approval token still binds the call's own arguments, so only the display changes.
 */
async function cardArguments(action: SentinelAction, ctx: ClassifyContext): Promise<Record<string, unknown>> {
  const secrets = await ctx.services.outboundSecrets({ tenant_id: ctx.tenant_id, created_by: ctx.created_by });
  if (secrets.length === 0) {
    return action.canonical_params;
  }
  const masked = maskServerSecrets({
    params: action.canonical_params,
    secrets,
    earlier: ctx.web_search.sentText,
    plumbingFields: action.mcp_search_plumbing_fields,
  });
  return masked ?? { details: HIDDEN_QUERY };
}

async function classifyGenericTool(action: SentinelAction, ctx: ClassifyContext): Promise<TierDecision> {
  const { services } = ctx;
  const name = action.tool_name.toLowerCase();

  // Offline: network-required tools are filtered from the list; a stale call
  // that slips through is auto-denied here.
  const offline = await services.isOffline({ tenant_id: ctx.tenant_id, created_by: ctx.created_by });
  const extraction = extractCardFields({
    tool_name: action.tool_name,
    canonical_params: await cardArguments(action, ctx),
    tool_type: action.tool_type,
    server_host: action.mcp_server_host,
    server_name: action.mcp_server_name,
    read_only_closed_world: action.mcp_hints.read_only_hint === true && action.mcp_hints.open_world_hint === false,
  });
  // A read is not a send by name, so it is not carded as an external-service send; its annotations still decide.
  const namedSend = extraction.external_service && !extraction.connector_read;
  // A connector read is private data, so a search in the same chat asks afterwards.
  const readsPrivateData = extraction.connector_read || containsSecretPath(action.canonical_params);
  // Any argument with a path shape is a private read whatever its name, so it never gets a grant.
  const pathLike = containsPathLikeValue(action.canonical_params);
  // Eligible for "Always allow" like an annotated read-only tool. Only an explicit open-world or
  // not-read-only claim, the search provider, a secret name or a path-like argument rules it out; the
  // arguments already ruled out recipients.
  const grantableRead =
    extraction.connector_read &&
    action.mcp_hints.open_world_hint !== true &&
    action.mcp_hints.read_only_hint !== false &&
    action.mcp_search_provider !== true &&
    !containsSecretPath(action.canonical_params) &&
    !pathLike;
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

  // A send whose card would hide a recipient, hidden characters or cut content is refused: approval must cover all of it.
  if (extraction.incomplete_send !== null) {
    // A demo refuses the call whatever the message holds, so it says so rather than ask for a fuller one.
    if (demoRefusesConnector({ action, ctx, extraction })) {
      return demoRefusal(DEMO_CONNECTOR_REFUSAL);
    }
    return autoDenyDecision({
      reason: 'incomplete_send_card',
      reason_detail: extraction.incomplete_send.model_message,
      owner_message: extraction.incomplete_send.owner_message,
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

  if (demoRefusesConnector({ action, ctx, extraction })) {
    return demoRefusal(DEMO_CONNECTOR_REFUSAL);
  }

  // A mail send to an address the owner has never mailed asks with its own card, naming each new address.
  const newMailRecipients = await mailNewRecipients({ action, ctx });
  if (newMailRecipients.length > 0) {
    const { fields } = extraction;
    const sentence = externalServiceWhat({
      tool_name: action.tool_name,
      destination: fields.destination,
      recipient: fields.recipient,
      amount: fields.amount,
    });
    return tier3Decision({
      card: {
        plain_what: `${newMailRecipients.map(address => `New recipient. You have never emailed ${escapeDisplayText(address)}.`).join(' ')} Approving adds them to your send list and sends. ${sentence}`,
        plain_why: plainWhy(ctx.agent_intent),
        cannot_be_undone: "Once this is sent, it can't be unsent.",
        why_asked_again: null,
        destination: fields.destination,
        recipient: fields.recipient,
        amount: fields.amount,
        parsed_command: null,
        outbound_text: fields.outbound_text,
        destination_host: fields.destination_host,
        outbound_truncated: fields.outbound_truncated,
        mail_new_recipients: newMailRecipients,
      },
      reason: 'mail_new_recipient',
      reason_detail: 'A mail send to an address that is not on the Email list.',
      sensitive_read: readsPrivateData,
      approval_token_id: await mintPlainToken({
        ctx,
        tool_name: action.tool_name,
        params: action.canonical_params,
        connector: connectorBindingFor(action),
      }),
    });
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
        plain_what: namedSend
          ? externalServiceWhat({
              tool_name: action.tool_name,
              destination: fields.destination,
              recipient: fields.recipient,
              amount: fields.amount,
            })
          : destructiveHint || extraction.connector_what === null
            ? `Run ${escapeDisplayText(action.tool_name)}, flagged as ${destructiveHint ? 'destructive' : 'reaching outside this machine'}.`
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
      // A send keeps its own reason whatever the annotations say, so no chat-wide answer ever covers it.
      reason: extraction.sends ? 'connector_send' : destructiveHint ? 'mcp_destructive_hint' : 'mcp_open_world_hint',
      reason_detail: 'MCP annotations flagged the tool; hints escalate only.',
      sensitive_read: readsPrivateData,
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
  if (namedSend || isDestructive || isInstall) {
    const { fields } = extraction;
    const what = namedSend
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
      reason: namedSend ? 'external_service' : isInstall ? 'install_action' : 'destructive_action',
      reason_detail: 'Name-based Tier 3 class.',
      sensitive_read: containsSecretPath(action.canonical_params),
      approval_token_id: await mintPlainToken({
        ctx,
        tool_name: action.tool_name,
        params: action.canonical_params,
        connector: connectorBindingFor(action),
      }),
    });
  }

  // A connector call named as a calendar change asks every time, whatever the connector claims about it:
  // no first-party pass and no standing grant, because a grant would cover every later event.
  if (action.tool_type === 'mcp' && isCalendarChangeToolName(action.tool_name)) {
    const card = connectorApprovalCard({ action, extraction, agent_intent: ctx.agent_intent });
    return tier3Decision({
      card: {
        ...card,
        plain_what: `A calendar change through ${escapeDisplayText(action.mcp_server_name ?? 'a connector you added')}. Check every detail below before you allow it.`,
        cannot_be_undone: 'Check the details before you go ahead.',
      },
      reason: 'connector_calendar_write',
      reason_detail: 'A calendar change from a connector always asks.',
      sensitive_read: readsPrivateData,
      secret_path_read: containsSecretPath(action.canonical_params) || pathLike,
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
  // for a sensitive path, and only while the tool still claims to be read-only and explicitly
  // closed-world (an absent openWorldHint means open). A connector read that the extractor
  // recognized is grantable without those hints, since its arguments carry no recipient.
  const closedWorldRead = readOnlyHint && action.mcp_hints.open_world_hint === false;
  if (
    action.tool_type === 'mcp' &&
    (closedWorldRead || grantableRead) &&
    !extraction.sends &&
    !containsSecretPath(action.canonical_params)
  ) {
    if (closedWorldRead && action.mcp_first_party === true) {
      return tier1Decision({
        reason: FIRST_PARTY_TOOL_REASON,
        reason_detail: `First-party read-only tool \`${action.tool_name}\`${
          action.mcp_server_name === undefined ? '' : ` on ${action.mcp_server_name}`
        }.`,
        sensitive_read: readsPrivateData,
      });
    }
    // A path-like argument is never admitted by a standing grant; a first-party read is not grant-based.
    if (
      action.mcp_server_name !== undefined &&
      !pathLike &&
      (await services.tool_grants.hasToolGrant({
        tenant_id: ctx.tenant_id,
        created_by: ctx.created_by,
        mcp_server_name: action.mcp_server_name,
        tool_name: action.tool_name,
        mcp_server_host: action.mcp_server_host ?? null,
      }))
    ) {
      return tier1Decision({
        reason: TOOL_GRANT_REASON,
        reason_detail: `Always allowed: \`${action.tool_name}\` on ${action.mcp_server_name}.`,
        sensitive_read: readsPrivateData,
        inspection: grantableRead,
      });
    }
  }

  // Host built-in read-only tools: Tier 1.
  if (action.tool_type === 'truefoundry-system' && readOnlyHint && !openWorldHint) {
    return tier1Decision({
      reason: 'local_read_only',
      reason_detail: `Local read-only tool \`${action.tool_name}\`.`,
      sensitive_read: containsSecretPath(action.canonical_params),
    });
  }

  // Fail closed: anything unrecognized is Tier 3 with a card.
  const card = connectorApprovalCard({ action, extraction, agent_intent: ctx.agent_intent });
  const recognized = extraction.connector_what !== null;
  return tier3Decision({
    card,
    reason: extraction.sends ? 'connector_send' : recognized ? 'connector_outbound' : 'unrecognized_tool',
    reason_detail: recognized
      ? 'Connector call that sends data out; always asks.'
      : 'Fail-closed: unrecognized tools require approval.',
    sensitive_read: readsPrivateData,
    inspection: grantableRead,
    grant_host: action.mcp_server_host ?? null,
    secret_path_read: containsSecretPath(action.canonical_params) || pathLike,
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
    plain_what:
      spaceToolLine(action) ??
      extraction.connector_what ??
      `This is a new tool from ${escapeDisplayText(action.mcp_server_name ?? 'a connector you added')}. Check what it will do before you allow it.`,
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

  if (action.tool_type === 'truefoundry-system' && action.mcp_server_name === GMAIL_SERVER_ID) {
    return steeringChecked({ decision: await classifyGmailTool(action, ctx), ctx, guests: [] });
  }
  if (action.tool_type === 'truefoundry-system' && action.mcp_server_name === CALENDAR_SERVER_ID) {
    return steeringChecked({ decision: await classifyCalendarTool(action, ctx), ctx, guests: [] });
  }
  if (
    action.tool_type === 'mcp' &&
    action.mcp_server_name === MAIL_CONNECTOR_NAME &&
    action.mcp_first_party === true &&
    isMailReadToolName(action.tool_name)
  ) {
    return classifyMailRead(action, ctx);
  }
  if (action.tool_type === 'truefoundry-system' && action.mcp_server_name === SCHEDULE_SERVER_ID) {
    return classifyScheduleTool(action, ctx);
  }
  if (action.tool_type === 'truefoundry-system' && action.mcp_server_name === PERSONA_SERVER_ID) {
    return classifyPersonaTool(action, ctx);
  }
  if (action.tool_type === 'truefoundry-system' && action.mcp_server_name === SPACE_SERVER_ID) {
    return classifySpaceTool(action);
  }

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
    if (
      name === 'run_code' &&
      (await ctx.services.sandboxWithoutAsking({ tenant_id: ctx.tenant_id, created_by: ctx.created_by }))
    ) {
      const silentRun = await runCodePlacement({ params: action.canonical_params, ctx });
      if (silentRun !== null) {
        return tier1Decision({ ...silentRun, sensitive_read: false });
      }
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
    // Embedded maps: Tier 3 whatever hints the tool declares, unless the user let maps run without
    // asking and the silent-run rules hold. The card names the place strings verbatim and the
    // configured hosts from server config; the destination never comes from model params.
    if (isMapsToolName(name)) {
      // Offline outranks the card: a stale call is denied, not offered for approval.
      if (await ctx.services.isOffline({ tenant_id: ctx.tenant_id, created_by: ctx.created_by })) {
        return autoDenyDecision({
          reason: 'offline_mode',
          reason_detail: holdSay(ctx.web_search.assistantName).maps_offline,
          sensitive_read: false,
        });
      }
      const runsWithoutAsking = await ctx.services.mapsWithoutAsking({
        tenant_id: ctx.tenant_id,
        created_by: ctx.created_by,
      });
      const silent = runsWithoutAsking ? await classifyMapsSilently({ action, ctx }) : undefined;
      if (silent !== undefined && 'decision' in silent) {
        return silent.decision;
      }
      const outbound = renderOutboundArguments(
        action.tool_name === RENDER_PLACES_TOOL_NAME
          ? placesOutboundArguments(action.canonical_params)
          : action.canonical_params,
      );
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
        reason: MAPS_ASK_REASON,
        reason_detail:
          silent === undefined
            ? holdSay(ctx.web_search.assistantName).maps_always
            : silent.held.ok
              ? null
              : guardRuleSay({ rule: silent.held.rule, assistant: ctx.web_search.assistantName }),
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

  if (action.tool_type === 'mcp') {
    const caldav = await classifyCaldavTool({
      action,
      review: action.caldav_event ?? null,
      hasStandingGrant: () => hasStandingToolGrant(ctx, action),
      mintToken: () =>
        mintPlainToken({
          ctx,
          tool_name: action.tool_name,
          params: action.canonical_params,
          connector: connectorBindingFor(action),
        }),
    });
    if (caldav !== undefined) {
      return steeringChecked({ decision: caldav, ctx, guests: action.caldav_event?.attendees ?? [] });
    }
  }

  return steeringChecked({ decision: await classifyGenericTool(action, ctx), ctx, guests: [] });
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

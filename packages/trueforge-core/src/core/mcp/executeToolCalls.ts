import { createHash } from 'node:crypto';
import type { ToolOutputScreenDecision } from '../../schemas/toolOutputScreen';
import {
  ImplementationPlanAdmissionBlockedError,
  StructuredEditPreconditionBlockedError,
  ToolPolicyBlockedError,
  ToolPreDispatchError,
} from '../errors';
import type { RegisteredPassthroughEvent } from '../events/PassthroughEvents';
import type {
  ApprovalDecision,
  MCPServerInitInfo,
  ToolAdmissionProvenance,
  ToolOutputTransform,
  ToolResultDisposition,
  ToolResultRemediation,
} from '../events/schema';
import type {
  InternalEnrichedAssistantMessage,
  InternalEnrichedToolCall,
  InternalToolCallInfo,
  LLMToolMessage,
} from '../llm/LLMTypes';
import type { CallToolResponse, MCPAuthRequired } from '../mcp/IMCPServer';
import type { AgentThreadCreateSubAgent } from '../runtime/AgentThread.types';
import { InternalEventType } from '../runtime/AgentThread.types';
import { awaitWithAbort, signalAbortError, throwIfSignalAborted } from '../util/abort';
// Only used to reconstruct a legacy pending-nudge entry's message text on hydration (see
// createToolCallMemoState below); every entry written by this version of the host already
// carries its own `message`, so this is a compatibility path, not a normal dependency.
import type { Logger } from 'winston';
import { identicalCallNudgeMessage } from '../runtime/contextUtils';
import { CALL_TOOL_NAME, tryUnwrapCallToolInput } from '../runtime/DeferredTool';
import type { SandboxInfo, WorkspaceVerificationReceiptCandidate } from '../sandbox/Sandbox';
import { approvalGrantKey } from './approvalGrant';
import type { MappedMCPTool } from './convertMCPServers';
import { isGithubFileContentUnavailable, isGithubFileRead } from './githubFileContents';
import {
  isApprovalRequiredResponse,
  isAuthRequired,
  isCallToolResponseCreateSubAgent,
  isCallToolResponseResult,
  isClientSideToolRequiredResponse,
  toolResultResponse,
} from './IMCPServer';
import { deniedToolCallText } from './ToolSet';
import { verifyPreDispatch, type SentinelCallIdentity, type SentinelServices } from '../permissions';

export interface ToolCallResult {
  message: LLMToolMessage;
  /** Exact normalized provider output before any response processor changes model-facing content. */
  rawContent: string;
  /** Host-enriched invocation metadata used for structural post-dispatch policy. */
  toolCallInfo: InternalToolCallInfo | undefined;
  /** Host-owned screen outcome, set only when this result was actually screened. */
  screen: ToolOutputScreenDecision | undefined;
  // Absent only for unknown-tool calls (LLM hallucinated a name not in toolMapping):
  // there is no backing MCP server. Downstream consumers (e.g. LargeToolResponse)
  // gate on `failure: false` before reading `info`, so the absence is naturally
  // short-circuited on the success path.
  info?: MappedMCPTool | undefined;
  failure: boolean;
  isStructuredContent: boolean;
  completedAt: string;
  memoized: boolean;
  /** Internal replay class used by non-progress policy; absent for a freshly dispatched result. */
  replayKind?: 'inspection' | 'verification' | undefined;
  repeatCount: number;
  blockedPrivateFallback: boolean;
  repeatedSideEffect: boolean;
  verificationReceiptCandidate: WorkspaceVerificationReceiptCandidate | undefined;
  disposition: ToolResultDisposition;
  remediation: ToolResultRemediation | undefined;
  /** Set by a response processor that changed the result text; absent when the model saw it as returned. */
  outputTransform?: ToolOutputTransform | undefined;
  admissionProvenance: ToolAdmissionProvenance;
}

export function shouldStopAfterMemoizedReplay(
  result: Pick<ToolCallResult, 'memoized' | 'repeatCount' | 'replayKind'>,
): boolean {
  if (!result.memoized) {
    return false;
  }
  return result.repeatCount >= (result.replayKind === 'verification' ? 3 : 2);
}

/**
 * Picks the stop message for a request ended by a repeated denied approval, a repeated
 * side-effecting action, a blocked private-repo fallback, or a memoized-replay read. The
 * GitHub-specific sentence is used only when the replayed read was actually a GitHub tool call
 * (`get_file_contents` on the `github` MCP server); every other repeated read (including a host
 * tool such as `list_spaces`) gets the generic sentence instead.
 */
export function selectRepeatedActionStopMessage(input: {
  repeatedDeniedApproval: boolean;
  repeatedSideEffects: boolean;
  blockedFallback: boolean;
  repeatedVerification: boolean;
  repeatedGithubFileRead: boolean;
}): string {
  if (input.repeatedDeniedApproval) {
    return 'The model repeated an action the user already denied, so the turn was stopped. Change strategy or explain why a different action is needed.';
  }
  if (input.repeatedSideEffects) {
    return 'The model attempted a side-effecting action whose dependent precondition was violated (a preceding workspace mutation did not complete as expected, or the durable execution marker was missing), so the turn was stopped and the action was not retried.';
  }
  if (input.blockedFallback) {
    return 'The model tried to fetch private repository content through a web tool after GitHub returned no file text. The turn was stopped; use an authenticated local checkout instead.';
  }
  if (input.repeatedVerification) {
    return 'The model repeated the same completed verification without changing the workspace. The cached result was returned twice and the turn was stopped; use its diagnostics or change the code before verifying again.';
  }
  if (input.repeatedGithubFileRead) {
    return 'The model repeated an identical GitHub file read after receiving its result. The cached result was returned and the turn was stopped; change strategy and use the local checkout.';
  }
  return 'The model repeated an identical read-only call after receiving its result. The cached result was returned and the turn was stopped; use it and change strategy.';
}

interface MemoEntry {
  response: CallToolResponse;
  failure: boolean;
  count: number;
  disposition: ToolResultDisposition;
  remediation: ToolResultRemediation | undefined;
}

export interface ToolCallMemoSnapshot {
  /** Completed calls whose response is safe to replay: inspections and host-scoped verification results. */
  read_results: {
    key: string;
    response: CallToolResponse;
    failure: boolean;
    count: number;
    disposition: ToolResultDisposition;
    remediation: ToolResultRemediation | undefined;
  }[];
  /** Side-effecting calls are remembered only as attempted; their responses are never replayed. */
  side_effect_attempts: { key: string; count: number }[];
  github_content_unavailable: boolean;
  consecutive_empty_inspection_batches: number;
  /**
   * Consecutive batches where every tool call was blocked before dispatch
   * (never_ran / policy_blocked) — the model retrying different argument
   * variants of a call the host never actually ran. Distinct from
   * consecutive_empty_inspection_batches, which counts dispatched reads that
   * came back empty.
   */
  consecutive_no_progress_batches: number;
  /**
   * Consecutive batches in which no call produced a usable result, whatever
   * the failure kind. A superset of consecutive_no_progress_batches: it also
   * counts calls that ran and failed, so alternating failure kinds (a sandbox
   * upload that errors, then an exec that never runs) cannot reset the count.
   */
  consecutive_failed_batches: number;
  /** How many times each distinct call (tool plus arguments) was made this turn. */
  call_signatures: { key: string; count: number }[];
  denied_approval_identities: string[];
  repeated_denied_approval: boolean;
  inspection_calls_before_edit: number;
  inspection_budget_warned: boolean;
  edit_observed: boolean;
  clarification_answered: boolean;
  /** Monotonic host-owned generation used to scope repeatable verification commands. */
  workspace_mutation_epoch: number;
  /**
   * Host-authored notes that were decided (a guard's counter just reached its nudge threshold)
   * but not yet appended to context, because other tool calls from the same assistant batch
   * (client-side or approval-required) were still open. Flushed into context once every call in
   * that batch has a result — see AgentThread's `send()` client-response and approval continuation
   * handling. Empty once flushed. Keyed by `kind` plus `signature`: for the identical-call repeat
   * guard, `signature` is the full call signature (tool plus canonical arguments), so distinct
   * argument variants of the same tool each get their own note; the three streak guards
   * (failed_batch, empty_inspection, no_progress) have no per-call signature and instead key
   * `signature` off a per-streak generation counter, so a later streak (after the guard's counter
   * has reset) is nudged again rather than reading as already sent. `tool_name` is carried
   * alongside only for the human-readable identical-call nudge text. A bare string is a legacy
   * name-only entry from a snapshot written before signatures were tracked here; both bare-string
   * and pre-generalization entries default to `kind: 'identical_call'` on hydration.
   */
  pending_identical_call_nudges: (string | SnapshotPendingHostNote)[];
  failed_batch_nudge_generation: number;
  empty_inspection_nudge_generation: number;
  no_progress_nudge_generation: number;
  /** Policy-denied calls in the current turn; the per-turn guard budget. */
  policy_blocked_calls_this_turn: number;
}

/** The guard kinds that can defer a host-authored note before stopping the turn. */
export type PendingHostNoteKind =
  'identical_call' | 'failed_batch' | 'empty_inspection' | 'no_progress' | 'policy_blocked';

/** See {@link ToolCallMemoSnapshot.pending_identical_call_nudges}. */
export interface PendingHostNote {
  kind: PendingHostNoteKind;
  /**
   * Full call signature for an `identical_call` note; for the three streak guards, a per-streak
   * generation number (as a string) so a later streak is tracked independently of an earlier one.
   */
  signature: string;
  tool_name: string;
  /** Exact host note text to append once flushed, built once when the note was decided so a
   * deferred note (e.g. one embedding a streak count) never needs reconstructing later. */
  message: string;
}

/** @deprecated Use {@link PendingHostNote}; the name predates the generalization to other guards. */
export type PendingIdenticalCallNudge = PendingHostNote;

/**
 * On-disk shape of a {@link PendingHostNote}: `kind` and `message` are optional so a snapshot
 * written before this generalization (which only ever recorded identical-call entries, without
 * either field) still hydrates.
 */
interface SnapshotPendingHostNote {
  kind?: PendingHostNoteKind;
  signature: string;
  tool_name: string;
  message?: string;
}

type LegacyToolCallMemoSnapshot = Omit<
  ToolCallMemoSnapshot,
  | 'read_results'
  | 'workspace_mutation_epoch'
  | 'consecutive_no_progress_batches'
  | 'consecutive_failed_batches'
  | 'call_signatures'
  | 'pending_identical_call_nudges'
  | 'failed_batch_nudge_generation'
  | 'empty_inspection_nudge_generation'
  | 'no_progress_nudge_generation'
  | 'policy_blocked_calls_this_turn'
> & {
  read_results: { key: string; response: CallToolResponse; failure: boolean; count: number }[];
  // Explicit `| undefined` (the repo's dominant optional-property convention under
  // exactOptionalPropertyTypes): a legacy snapshot predating a counter omits the key entirely.
  workspace_mutation_epoch?: number | undefined;
  consecutive_no_progress_batches?: number | undefined;
  consecutive_failed_batches: number | undefined;
  call_signatures: { key: string; count: number }[] | undefined;
  pending_identical_call_nudges?: (string | SnapshotPendingHostNote)[] | undefined;
  failed_batch_nudge_generation?: number | undefined;
  empty_inspection_nudge_generation?: number | undefined;
  no_progress_nudge_generation?: number | undefined;
  // Optional like the counters above: a snapshot written before this guard existed
  // omits the key, and hydration defaults it to 0.
  policy_blocked_calls_this_turn?: number | undefined;
};

export interface ToolCallMemoState {
  entries: Map<string, MemoEntry>;
  inflight: Map<string, Promise<MemoEntry | null>>;
  sideEffectAttempts: Map<string, number>;
  githubContentUnavailable: boolean;
  consecutiveEmptyInspectionBatches: number;
  consecutiveNoProgressBatches: number;
  consecutiveFailedBatches: number;
  callSignatures: Map<string, number>;
  deniedApprovalIdentities: Set<string>;
  repeatedDeniedApproval: boolean;
  inspectionCallsBeforeEdit: number;
  inspectionBudgetWarned: boolean;
  editObserved: boolean;
  clarificationAnswered: boolean;
  workspaceMutationEpoch: number;
  repeatedSideEffect: boolean;
  /** In-memory mirror of {@link ToolCallMemoSnapshot.pending_identical_call_nudges}, generalized to
   * carry every guard's `kind` (see {@link PendingHostNoteKind}) and always hydrated with an
   * explicit `kind` and `message` — a legacy entry recorded before this generalization is hydrated
   * as `kind: 'identical_call'` with its message reconstructed, see {@link createToolCallMemoState}. */
  pendingHostNotes: PendingHostNote[];
  /** Per-streak generation for the three streak guards (see {@link PendingHostNote.signature}),
   * incremented every time the matching counter resets to 0 so a later streak is nudged again
   * rather than reading as already sent via the marker left by an earlier streak in the same turn. */
  failedBatchNudgeGeneration: number;
  emptyInspectionNudgeGeneration: number;
  noProgressNudgeGeneration: number;
  /**
   * Policy-denied calls in the current turn. Unlike the consecutive-batch streaks above,
   * this never resets on interleaved successful calls: a policy denial is deterministic
   * for the conversation, so refused calls alternating with successful ones are still the
   * model pushing against the same permission wall. It lives in the memo (not in a
   * separate field) so an approval/tool-response continuation of the same turn hydrates
   * the standing count instead of restarting at 0; a genuinely new user message resets
   * the whole memo. Only true policy denials count — structured-edit precondition
   * failures and implementation-plan admission blocks carry their own remediation reason
   * codes and recovery paths, and must not be misdiagnosed as "not allowed here".
   */
  policyBlockedCallsThisTurn: number;
}

export function createToolCallMemoState(
  snapshot?: ToolCallMemoSnapshot | LegacyToolCallMemoSnapshot,
): ToolCallMemoState {
  const state: ToolCallMemoState = {
    entries: new Map(),
    inflight: new Map(),
    sideEffectAttempts: new Map(),
    githubContentUnavailable: false,
    consecutiveEmptyInspectionBatches: 0,
    consecutiveNoProgressBatches: 0,
    consecutiveFailedBatches: 0,
    callSignatures: new Map(),
    deniedApprovalIdentities: new Set(),
    repeatedDeniedApproval: false,
    inspectionCallsBeforeEdit: 0,
    inspectionBudgetWarned: false,
    editObserved: false,
    clarificationAnswered: false,
    workspaceMutationEpoch: 0,
    repeatedSideEffect: false,
    pendingHostNotes: [],
    failedBatchNudgeGeneration: 0,
    emptyInspectionNudgeGeneration: 0,
    noProgressNudgeGeneration: 0,
    policyBlockedCallsThisTurn: 0,
  };
  if (snapshot === undefined) {
    return state;
  }
  for (const entry of snapshot.read_results) {
    let disposition: ToolResultDisposition;
    let remediation: ToolResultRemediation | undefined;
    if ('disposition' in entry) {
      disposition = entry.disposition;
      remediation = entry.remediation;
    } else {
      if (!isCallToolResponseResult(entry.response)) {
        continue;
      }
      disposition = entry.response.result.isError === true ? 'executed_nonzero' : 'executed_ok';
      remediation = undefined;
    }
    state.entries.set(entry.key, {
      response: entry.response,
      failure: entry.failure,
      count: entry.count,
      disposition,
      remediation,
    });
  }
  for (const entry of snapshot.side_effect_attempts) {
    state.sideEffectAttempts.set(entry.key, entry.count);
  }
  state.githubContentUnavailable = snapshot.github_content_unavailable;
  state.consecutiveEmptyInspectionBatches = snapshot.consecutive_empty_inspection_batches;
  state.deniedApprovalIdentities = new Set(snapshot.denied_approval_identities);
  state.repeatedDeniedApproval = snapshot.repeated_denied_approval;
  state.inspectionCallsBeforeEdit = snapshot.inspection_calls_before_edit;
  state.inspectionBudgetWarned = snapshot.inspection_budget_warned;
  state.editObserved = snapshot.edit_observed;
  state.clarificationAnswered = snapshot.clarification_answered;
  // Runtime hydration is the compatibility boundary for snapshots written
  // before the mutation epoch (or the no-progress counter) became part of
  // the canonical contract.
  state.workspaceMutationEpoch = snapshot.workspace_mutation_epoch ?? 0;
  state.consecutiveNoProgressBatches = snapshot.consecutive_no_progress_batches ?? 0;
  state.consecutiveFailedBatches = snapshot.consecutive_failed_batches ?? 0;
  for (const entry of snapshot.call_signatures ?? []) {
    state.callSignatures.set(entry.key, entry.count);
  }
  // Legacy snapshots stored a bare tool name, or a {signature, tool_name} pair with no `kind` or
  // `message` — both predate this generalization, when every entry was necessarily an
  // identical-call nudge. Normalize both to the full PendingHostNote shape, reconstructing the
  // message text (safe: identicalCallNudgeMessage is pure and deterministic in the signature).
  state.pendingHostNotes = (snapshot.pending_identical_call_nudges ?? []).map(entry => {
    if (typeof entry === 'string') {
      return {
        kind: 'identical_call' as const,
        signature: '',
        tool_name: entry,
        message: identicalCallNudgeMessage(entry, ''),
      };
    }
    const kind = entry.kind ?? 'identical_call';
    const message = entry.message ?? identicalCallNudgeMessage(entry.tool_name, entry.signature);
    return { kind, signature: entry.signature, tool_name: entry.tool_name, message };
  });
  state.failedBatchNudgeGeneration = snapshot.failed_batch_nudge_generation ?? 0;
  state.emptyInspectionNudgeGeneration = snapshot.empty_inspection_nudge_generation ?? 0;
  state.noProgressNudgeGeneration = snapshot.no_progress_nudge_generation ?? 0;
  state.policyBlockedCallsThisTurn = snapshot.policy_blocked_calls_this_turn ?? 0;
  return state;
}

export function cloneToolCallMemoState(source: ToolCallMemoState): ToolCallMemoState {
  const state = createToolCallMemoState();
  for (const [key, entry] of source.entries) {
    state.entries.set(key, { ...entry });
  }
  for (const [key, count] of source.sideEffectAttempts) {
    state.sideEffectAttempts.set(key, count);
  }
  state.githubContentUnavailable = source.githubContentUnavailable;
  state.consecutiveEmptyInspectionBatches = source.consecutiveEmptyInspectionBatches;
  state.consecutiveNoProgressBatches = source.consecutiveNoProgressBatches;
  state.consecutiveFailedBatches = source.consecutiveFailedBatches;
  for (const [key, count] of source.callSignatures) {
    state.callSignatures.set(key, count);
  }
  state.deniedApprovalIdentities = new Set(source.deniedApprovalIdentities);
  state.repeatedDeniedApproval = source.repeatedDeniedApproval;
  state.inspectionCallsBeforeEdit = source.inspectionCallsBeforeEdit;
  state.inspectionBudgetWarned = source.inspectionBudgetWarned;
  state.editObserved = source.editObserved;
  state.clarificationAnswered = source.clarificationAnswered;
  state.workspaceMutationEpoch = source.workspaceMutationEpoch;
  state.repeatedSideEffect = source.repeatedSideEffect;
  state.pendingHostNotes = source.pendingHostNotes.map(entry => ({ ...entry }));
  state.failedBatchNudgeGeneration = source.failedBatchNudgeGeneration;
  state.emptyInspectionNudgeGeneration = source.emptyInspectionNudgeGeneration;
  state.noProgressNudgeGeneration = source.noProgressNudgeGeneration;
  state.policyBlockedCallsThisTurn = source.policyBlockedCallsThisTurn;
  return state;
}

export function toToolCallMemoSnapshot(state: ToolCallMemoState): ToolCallMemoSnapshot {
  return {
    read_results: [...state.entries.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => ({
        key,
        response: entry.response,
        failure: entry.failure,
        count: entry.count,
        disposition: entry.disposition,
        remediation: entry.remediation,
      })),
    side_effect_attempts: [...state.sideEffectAttempts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, count]) => ({ key, count })),
    github_content_unavailable: state.githubContentUnavailable,
    consecutive_empty_inspection_batches: state.consecutiveEmptyInspectionBatches,
    consecutive_no_progress_batches: state.consecutiveNoProgressBatches,
    consecutive_failed_batches: state.consecutiveFailedBatches,
    call_signatures: [...state.callSignatures.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, count]) => ({ key, count })),
    denied_approval_identities: [...state.deniedApprovalIdentities].sort(),
    repeated_denied_approval: state.repeatedDeniedApproval,
    inspection_calls_before_edit: state.inspectionCallsBeforeEdit,
    inspection_budget_warned: state.inspectionBudgetWarned,
    edit_observed: state.editObserved,
    clarification_answered: state.clarificationAnswered,
    workspace_mutation_epoch: state.workspaceMutationEpoch,
    pending_identical_call_nudges: state.pendingHostNotes.map(entry => ({ ...entry })),
    failed_batch_nudge_generation: state.failedBatchNudgeGeneration,
    empty_inspection_nudge_generation: state.emptyInspectionNudgeGeneration,
    no_progress_nudge_generation: state.noProgressNudgeGeneration,
    policy_blocked_calls_this_turn: state.policyBlockedCallsThisTurn,
  };
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalValue);
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalValue(nested)]),
  );
}

function isToolArgumentRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseToolArguments(argumentsJson: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(argumentsJson || '{}');
  if (!isToolArgumentRecord(parsed)) {
    throw new Error('Tool arguments must be a JSON object');
  }
  return parsed;
}

/**
 * Sentinel pre-dispatch verification for an approved Tier 3 call. Returns an
 * error message when the call must not execute (stale offline context,
 * invalid or already-used approval token, parameters changed since
 * approval), or undefined when cleared. A valid tracked-execution approval
 * records its grant as a side effect.
 */
async function verifySentinelPreDispatch(input: {
  toolCall: InternalEnrichedToolCall;
  approvalDecisions: Map<string, ApprovalDecision>;
  sentinel: { services: SentinelServices; identity: SentinelCallIdentity } | undefined;
}): Promise<string | undefined> {
  const { toolCall, approvalDecisions, sentinel } = input;
  if (sentinel === undefined) {
    return undefined;
  }
  const info = toolCall.tool_info;
  if (info.tier !== 3 && info.tier !== 2) {
    return undefined;
  }
  if (info.tier === 3 && approvalDecisions.get(toolCall.id)?.status !== 'allow') {
    return undefined;
  }
  let canonicalParams: Record<string, unknown>;
  try {
    canonicalParams = parseToolArguments(toolCall.function.arguments);
  } catch {
    return 'Tool arguments could not be parsed; request approval again.';
  }
  // Deferred `call_tool` invocations are classified (and their approval tokens
  // minted) against the underlying tool's name and inner input, not the wrapper
  // (see DeferredTool.toolCallInfo). When mint unwrapped, the verifier must hash
  // the same inner input, or every approved deferred call fails as "action
  // identity changed". Wrapper-classified fallbacks keep
  // original_tool_name === 'call_tool' and are verified against the wrapper.
  if (info.is_deferred === true && info.original_tool_name !== CALL_TOOL_NAME) {
    canonicalParams = tryUnwrapCallToolInput(canonicalParams) ?? canonicalParams;
  }
  // When the mint site recorded its exact identity (sandbox: invoked name and
  // normalized args, while original_tool_name is remapped for display), verify
  // against the recorded values instead of reconstructing.
  if (info.mint_canonical_params !== undefined) {
    canonicalParams = info.mint_canonical_params;
  }
  const offline = await sentinel.services.isOffline({
    tenant_id: sentinel.identity.tenant_id,
    created_by: sentinel.identity.created_by,
  });
  return verifyPreDispatch({
    call: {
      tool_name: info.mint_tool_name ?? info.original_tool_name,
      tool_type: info.type,
      canonical_params: canonicalParams,
      tier: info.tier,
      approval_token_id: info.approval_token_id ?? null,
      approval_binding: info.approval_binding ?? null,
      shell_binding: info.shell_binding ?? null,
    },
    ctx: { ...sentinel.identity, services: sentinel.services, offline },
  });
}

/** Batches of failures in a row before the model is told to stop varying and read the error. */
export const FAILED_BATCH_NUDGE_AT = 3;
/** Batches of failures in a row before the host ends the turn. */
export const FAILED_BATCH_STOP_AT = 5;
/** Consecutive empty inspections before the model is told to stop rephrasing and change strategy. */
export const EMPTY_INSPECTION_NUDGE_AT = 3;
/** Consecutive empty inspections before the host ends the turn. */
export const EMPTY_INSPECTION_STOP_AT = 5;
/** Consecutive blocked-before-dispatch batches before the model is told to diagnose the blocker. */
export const NO_PROGRESS_NUDGE_AT = 3;
/** Consecutive blocked-before-dispatch batches before the host ends the turn. */
export const NO_PROGRESS_STOP_AT = 5;
/**
 * Policy-blocked calls in one turn before the model is told the tool is not allowed here.
 * Unlike the consecutive-batch guards above, this budget never resets on interleaved
 * progress: a policy denial is deterministic for the conversation, so a write that is
 * refused, then a successful read, then another refused write is still the same wall.
 */
export const POLICY_BLOCKED_NUDGE_AT = 2;
/** Policy-blocked calls in one turn before the host ends the turn. */
export const POLICY_BLOCKED_STOP_AT = 3;
/** Times the same call may be made in one turn before the host ends the turn. */
export const IDENTICAL_CALL_STOP_AT = 4;
/**
 * Occurrence at which the host nudges instead of stopping: the second time a signature repeats,
 * one internal system message is appended telling the model the result is already above and it
 * must not repeat the call (see IDENTICAL_CALL_NUDGE_MESSAGE in AgentThread's runtime context
 * helpers). The turn is not stopped until IDENTICAL_CALL_STOP_AT.
 */
export const IDENTICAL_CALL_NUDGE_AT = 2;

/**
 * What makes two calls "the same" for the per-turn repeat budget: the tool and its arguments.
 * Host-owned tools declare `intent` as user-facing wording that changes between otherwise
 * identical retries, so it is left out for them; a connector's `intent` argument is its own
 * business and stays in. Unlike the memo key this ignores effect and workspace epoch on
 * purpose: a call retried after an unrelated write is still the same call being retried.
 */
export function toolCallSignature(call: Pick<InternalEnrichedToolCall, 'function' | 'tool_info'>): string {
  const presentationalIntent = call.tool_info.type === 'truefoundry-system';
  let args: unknown;
  try {
    const parsed: unknown = JSON.parse(call.function.arguments);
    args =
      presentationalIntent && typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? Object.fromEntries(Object.entries(parsed).filter(([key]) => key !== 'intent'))
        : parsed;
  } catch {
    args = call.function.arguments;
  }
  return JSON.stringify([call.function.name, canonicalValue(args)]);
}

function memoKey(
  toolInfo: MappedMCPTool,
  args: Record<string, unknown>,
  effect: InternalEnrichedToolCall['tool_info']['effect'],
  workspaceMutationEpoch: number,
  commandExecution?: InternalEnrichedToolCall['tool_info']['command_execution'],
): string {
  const executableArgs =
    effect === 'verify' ? Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'intent')) : args;
  const invocationIdentity =
    effect === 'verify' && commandExecution !== undefined
      ? { command_execution: canonicalValue(commandExecution) }
      : canonicalValue(executableArgs);
  const identity: unknown[] = [toolInfo.toolSet.id, toolInfo.originalToolName, invocationIdentity];
  if (effect === 'verify') {
    identity.push({ workspace_mutation_epoch: workspaceMutationEpoch });
  }
  return JSON.stringify(identity);
}

function legacyMemoKey(toolInfo: MappedMCPTool, args: Record<string, unknown>): string {
  return JSON.stringify([toolInfo.toolSet.id, toolInfo.originalToolName, canonicalValue(args)]);
}

function existingSideEffectAttempt(
  memoState: ToolCallMemoState,
  key: string,
  toolInfo: MappedMCPTool,
  args: Record<string, unknown>,
  effect: InternalEnrichedToolCall['tool_info']['effect'],
  workspaceMutationEpoch = memoState.workspaceMutationEpoch,
): { key: string; count: number } {
  const currentCount = memoState.sideEffectAttempts.get(key);
  if (currentCount !== undefined) {
    return { key, count: currentCount };
  }
  if (effect === 'verify' && workspaceMutationEpoch === 0) {
    const legacyKey = legacyMemoKey(toolInfo, args);
    const legacyCount = memoState.sideEffectAttempts.get(legacyKey);
    if (legacyCount !== undefined) {
      return { key: legacyKey, count: legacyCount };
    }
  }
  return { key, count: 0 };
}

/**
 * Mark host-dispatched side effects before they cross the execution boundary.
 * The caller must persist the returned memo state before passing the returned
 * call ids back to `executeToolCalls`.
 */
export function prepareSideEffectToolCalls({
  assistantMessage,
  toolMapping,
  approvalDecisions,
  memoState,
}: {
  assistantMessage: InternalEnrichedAssistantMessage;
  toolMapping: Map<string, MappedMCPTool>;
  approvalDecisions: Map<string, ApprovalDecision>;
  memoState: ToolCallMemoState;
}): { callIds: Set<string>; keysByCallId: Map<string, string> } {
  const prepared = new Set<string>();
  const keysByCallId = new Map<string, string>();
  let projectedMutationEpoch = memoState.workspaceMutationEpoch;
  for (const toolCall of assistantMessage.tool_calls ?? []) {
    const toolInfo = toolMapping.get(toolCall.function.name);
    if (
      toolInfo === undefined ||
      toolCall.tool_info.pre_dispatch_failure !== undefined ||
      toolCall.tool_info.is_thread_creation === true ||
      toolCall.tool_info.is_client_side === true ||
      toolCall.tool_info.effect === 'inspect' ||
      (toolCall.tool_info.effect === undefined && toolCall.tool_info.read_only_hint === true) ||
      approvalDecisions.get(toolCall.id)?.status === 'deny' ||
      (toolCall.tool_info.is_approval_required === true && approvalDecisions.get(toolCall.id)?.status !== 'allow')
    ) {
      continue;
    }
    try {
      const args = parseToolArguments(toolCall.function.arguments);
      const key = memoKey(
        toolInfo,
        args,
        toolCall.tool_info.effect,
        projectedMutationEpoch,
        toolCall.tool_info.command_execution,
      );
      if (toolCall.tool_info.effect === 'verify' && memoState.entries.has(key)) {
        continue;
      }
      if (
        existingSideEffectAttempt(memoState, key, toolInfo, args, toolCall.tool_info.effect, projectedMutationEpoch)
          .count > 0
      ) {
        continue;
      }
      memoState.sideEffectAttempts.set(key, 1);
      prepared.add(toolCall.id);
      keysByCallId.set(toolCall.id, key);
      if (
        toolCall.tool_info.effect === 'edit' ||
        toolCall.tool_info.effect === 'commit' ||
        toolCall.tool_info.effect === 'execute'
      ) {
        projectedMutationEpoch += 1;
      }
    } catch {
      // Malformed arguments cannot cross the execution boundary. The normal
      // execution path records the structured failure for the model.
    }
  }
  return { callIds: prepared, keysByCallId };
}

function hasGithubContentUrl(value: unknown): boolean {
  if (typeof value === 'string') {
    try {
      const url = new URL(value);
      return (
        url.hostname === 'github.com' ||
        url.hostname === 'api.github.com' ||
        url.hostname.endsWith('.githubusercontent.com')
      );
    } catch {
      return false;
    }
  }
  if (Array.isArray(value)) {
    return value.some(hasGithubContentUrl);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.values(value).some(hasGithubContentUrl);
  }
  return false;
}

export interface ExecuteToolCallsResult {
  toolCallResults: ToolCallResult[];
  initializationInfo: MCPServerInitInfo[];
  createThreadEvents: AgentThreadCreateSubAgent[];
  sandboxCreated: SandboxInfo | undefined;
  authRequirementInfo: MCPAuthRequired[];
  approvalRequiredToolCalls: InternalEnrichedToolCall[];
  clientSideToolCalls: InternalEnrichedToolCall[];
  events: RegisteredPassthroughEvent[];
}

interface ToolCallExecutionOutcome {
  toolCall: InternalEnrichedToolCall;
  toolInfo: MappedMCPTool | undefined;
  response: CallToolResponse;
  failure: boolean;
  completedAt: string;
  memoized: boolean;
  repeatCount: number;
  blockedPrivateFallback: boolean;
  repeatedSideEffect: boolean;
  disposition: ToolResultDisposition;
  remediation: ToolResultRemediation | undefined;
  /** Set by a response processor that changed the result text; absent when the model saw it as returned. */
  outputTransform?: ToolOutputTransform | undefined;
  admissionProvenance: ToolAdmissionProvenance;
}

function admissionForCall(input: {
  toolCallId: string;
  approvalDecisions: ReadonlyMap<string, ApprovalDecision>;
  admissionProvenance: ReadonlyMap<string, ToolAdmissionProvenance> | undefined;
}): ToolAdmissionProvenance {
  const explicit = input.admissionProvenance?.get(input.toolCallId);
  if (explicit !== undefined) {
    return explicit;
  }
  const decision = input.approvalDecisions.get(input.toolCallId);
  if (decision === undefined) {
    return { source: 'automatic' };
  }
  return {
    source: 'user_approval',
    decision: decision.status,
    ...(decision.status === 'allow' && decision.scope !== undefined ? { scope: decision.scope } : {}),
  };
}

/**
 * Fallback cap on concurrently dispatched read-only (Phase A) tool calls per
 * assistant batch when the host does not supply `toolDispatchMaxConcurrency`.
 * Mirrors the `TOOL_DISPATCH_MAX_CONCURRENCY` default in
 * `packages/trueforge/src/config.ts`; the host value always wins when provided.
 */
export const DEFAULT_TOOL_DISPATCH_MAX_CONCURRENCY = 4;

/**
 * Fallback per-call dispatch deadline in milliseconds when the host does not
 * supply `toolCallTimeoutMs`. 4 minutes: the normal ceiling for a single tool
 * call. run_code is the exception — it gets its own provisioning-sized deadline via
 * `runCodeToolCallTimeoutMs` (image-pull bound + max run + margin), so the
 * long deadline is scoped to the one tool that needs it.
 */
export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 240_000;

/**
 * Fallback run_code dispatch deadline in milliseconds when the host does not
 * supply `runCodeToolCallTimeoutMs`. 21 minutes = 600 s image-pull bound +
 * 600 s max run + 60 s margin at default sandbox bounds; the host should
 * pass the value derived from its configured bounds instead of relying on
 * this default.
 */
export const DEFAULT_RUN_CODE_TOOL_CALL_TIMEOUT_MS = 1_260_000;

/**
 * the long provisioning-sized deadline belongs to sandbox/run_code alone. Tool identity
 * comes from the tool mapping (toolSet.name 'sandbox', originalToolName
 * 'run_code').
 */
function isRunCodeToolCall(toolInfo: { toolSet: { name: string }; originalToolName: string }): boolean {
  return toolInfo.toolSet.name === 'sandbox' && toolInfo.originalToolName === 'run_code';
}

/**
 * Phase-A classification: read-only calls that may dispatch concurrently.
 * Deliberately narrower than the memoization predicate (which also replays
 * GitHub file reads): only host-classified inspections and MCP
 * `readOnlyHint` tools join the concurrent phase; anything else stays in the
 * sequential stateful phase. Client-side and sub-agent-creation calls resolve
 * locally without provider I/O, so they stay concurrency-neutral in Phase B
 * instead of consuming a Phase-A permit.
 */
function isReadOnlyDispatch(toolCall: InternalEnrichedToolCall): boolean {
  if (toolCall.tool_info.is_client_side === true || toolCall.tool_info.is_thread_creation === true) {
    return false;
  }
  return toolCall.tool_info.effect === 'inspect' || toolCall.tool_info.read_only_hint === true;
}

/**
 * Per-batch admission limiter for concurrent read-only dispatch. At most
 * `maxConcurrency` tasks hold a permit at once; a released permit transfers
 * directly to the longest-waiting task. `acquire` rejects (and leaves the
 * queue) when its signal aborts, so an aborted waiter never steals a later
 * permit. Constructed fresh per `executeToolCalls` invocation — permits never
 * cross batch boundaries.
 */
function createDispatchLimiter(maxConcurrency: number): {
  acquire: (signal: AbortSignal | undefined) => Promise<void>;
  release: () => void;
} {
  const limit = Math.max(1, Math.floor(maxConcurrency));
  let available = limit;
  const waiters: (() => void)[] = [];
  return {
    acquire: (signal: AbortSignal | undefined): Promise<void> => {
      if (signal?.aborted === true) {
        return Promise.reject(signalAbortError(signal));
      }
      if (available > 0) {
        available -= 1;
        return Promise.resolve();
      }
      return new Promise<void>((resolve, reject) => {
        const grant = (): void => {
          // Granted: out of the queue, so a later abort is the dispatch
          // wait's problem, not the queue's.
          signal?.removeEventListener('abort', onAbort);
          resolve();
        };
        const onAbort = (): void => {
          if (signal === undefined) {
            return;
          }
          const queued = waiters.indexOf(grant);
          if (queued !== -1) {
            waiters.splice(queued, 1);
            reject(signalAbortError(signal));
          }
        };
        waiters.push(grant);
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    },
    release: (): void => {
      const next = waiters.shift();
      if (next === undefined) {
        available += 1;
      } else {
        next();
      }
    },
  };
}

/**
 * Rejection reason when a tool-call dispatch exceeds its per-call deadline.
 * Extends Error so existing `error.message` handling is unaffected; the
 * subclass lets the memoized dispatch path distinguish a real timeout (whose
 * late provider settlement must be logged and detached from the memo) from a
 * provider error or an abort.
 */
export class ToolCallTimeoutError extends Error {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly timeoutMs: number;

  constructor(input: { toolCallId: string; toolName: string; timeoutMs: number }) {
    super(`Tool call ${input.toolCallId} (${input.toolName}) timed out after ${String(input.timeoutMs)}ms`);
    this.name = 'ToolCallTimeoutError';
    this.toolCallId = input.toolCallId;
    this.toolName = input.toolName;
    this.timeoutMs = input.timeoutMs;
  }
}

/**
 * Races a dispatched provider call against a per-call deadline. The deadline
 * bounds the whole dispatch wait (Phase-A permit queue plus the provider
 * call), so a call stuck behind hung dispatches still gets its own deadline
 * instead of waiting indefinitely. A timeout before the provider started
 * records `never_ran` (the side-effect marker is released); a timeout after
 * the provider started records `outcome_unknown` (the marker is retained).
 * The timer is cleared as soon as the race settles; a timed-out provider
 * promise is left to settle on its own — the deadline bounds the turn's wait,
 * it does not cancel the underlying provider call (no signal reaches
 * `callTool`).
 */
function withCallTimeout<T>(
  operation: Promise<T>,
  input: { timeoutMs: number | undefined; toolName: string; toolCallId: string },
): Promise<T> {
  const timeoutMs = input.timeoutMs;
  if (timeoutMs === undefined) {
    return operation;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new ToolCallTimeoutError({ toolCallId: input.toolCallId, toolName: input.toolName, timeoutMs }));
    }, timeoutMs);
  });
  return Promise.race([operation, deadline]).finally(() => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  });
}

export async function executeToolCalls({
  assistantMessage,
  toolMapping,
  threadId,
  approvalDecisions,
  admissionProvenance,
  memoState,
  preparedSideEffectCalls,
  signal,
  toolDispatchMaxConcurrency,
  toolCallTimeoutMs,
  runCodeToolCallTimeoutMs,
  logger,
  sentinel,
}: {
  assistantMessage: InternalEnrichedAssistantMessage;
  toolMapping: Map<string, MappedMCPTool>;
  threadId: string;
  approvalDecisions: Map<string, ApprovalDecision>;
  admissionProvenance?: ReadonlyMap<string, ToolAdmissionProvenance> | undefined;
  memoState: ToolCallMemoState;
  /** Side effects whose durable pre-dispatch marker was persisted by the caller. */
  preparedSideEffectCalls?: {
    callIds: ReadonlySet<string>;
    keysByCallId: ReadonlyMap<string, string>;
  };
  /**
   * Turn-level abort signal. A call aborted while queued for a Phase-A permit
   * (or before dispatch) never started, so it records `never_ran`; a call
   * aborted mid-dispatch records `outcome_unknown`.
   */
  signal?: AbortSignal | undefined;
  /**
   * Cap on concurrently dispatched Phase-A (read-only) calls in this batch.
   * Defaults to {@link DEFAULT_TOOL_DISPATCH_MAX_CONCURRENCY} when the host
   * does not supply a value.
   */
  toolDispatchMaxConcurrency?: number | undefined;
  /**
   * Per-call dispatch deadline in milliseconds, starting at provider
   * invocation. A timeout rejects with {@link ToolCallTimeoutError}: the catch
   * path records `outcome_unknown` with `execution_interrupted` remediation
   * and retains the side-effect marker. Bounds the turn's wait only — it does
   * not cancel the underlying provider call.
   */
  toolCallTimeoutMs?: number | undefined;
  /**
   * run_code's own dispatch deadline in milliseconds. Scoped to
   * sandbox/run_code (the only tool whose honest worst case — a first-run
   * image pull plus the longest run — needs the provisioning-sized deadline); every
   * other tool uses `toolCallTimeoutMs`. Should be derived from the
   * configured `image_pull_timeout_seconds` + `max_timeout_seconds` bounds.
   */
  runCodeToolCallTimeoutMs?: number | undefined;
  /**
   * Optional host logger. Used only for debug-level diagnostics that never
   * affect dispatch semantics — currently the late settlement of a provider
   * call the turn already stopped waiting for after a dispatch timeout.
   */
  logger?: Logger | undefined;
  /**
   * Sentinel pre-dispatch verification and Tier 3 outcome audit. When present,
   * approved Tier 3 calls are re-verified byte-for-byte immediately before
   * invocation, and Tier 3 approved/denied outcomes are audit-logged.
   */
  sentinel?:
    | {
        services: SentinelServices;
        identity: SentinelCallIdentity;
      }
    | undefined;
}): Promise<ExecuteToolCallsResult> {
  const toolMessages: ToolCallResult[] = [];
  const initializationInfo: MCPServerInitInfo[] = [];
  const createThreadEvents: AgentThreadCreateSubAgent[] = [];
  const authRequirementInfo: MCPAuthRequired[] = [];
  const approvalRequiredToolCalls: InternalEnrichedToolCall[] = [];
  const clientSideToolCalls: InternalEnrichedToolCall[] = [];
  const passthroughEvents: RegisteredPassthroughEvent[] = [];
  let sandboxCreated: SandboxInfo | undefined;

  if (!assistantMessage.tool_calls) {
    return {
      toolCallResults: toolMessages,
      initializationInfo,
      createThreadEvents,
      sandboxCreated,
      authRequirementInfo,
      approvalRequiredToolCalls,
      clientSideToolCalls,
      events: passthroughEvents,
    };
  }

  // A fallback issued in the same model batch cannot be conditional on the GitHub read result.
  // Treat it as premature and block it before concurrent dispatch closes the guard's race window.
  const batchContainsGithubFileRead = assistantMessage.tool_calls.some(toolCall => {
    const toolInfo = toolMapping.get(toolCall.function.name);
    return toolInfo !== undefined && isGithubFileRead(toolInfo.toolSet.name, toolInfo.originalToolName);
  });

  // Per-batch permit pool shared by every Phase-A (read-only) dispatch below.
  const dispatchLimiter = createDispatchLimiter(toolDispatchMaxConcurrency ?? DEFAULT_TOOL_DISPATCH_MAX_CONCURRENCY);
  const callTimeoutMs = toolCallTimeoutMs ?? DEFAULT_TOOL_CALL_TIMEOUT_MS;
  const runCodeCallTimeoutMs = runCodeToolCallTimeoutMs ?? DEFAULT_RUN_CODE_TOOL_CALL_TIMEOUT_MS;

  const executeOne = async (toolCall: InternalEnrichedToolCall): Promise<ToolCallExecutionOutcome> => {
    const toolInfo = toolMapping.get(toolCall.function.name);
    const admission = admissionForCall({
      toolCallId: toolCall.id,
      approvalDecisions,
      admissionProvenance,
    });
    if (!toolInfo) {
      return {
        toolCall,
        toolInfo,
        response: toolResultResponse({ text: `Tool ${toolCall.function.name} not found in tool mapping` }),
        failure: true,
        completedAt: new Date().toISOString(),
        memoized: false,
        repeatCount: 1,
        blockedPrivateFallback: false,
        repeatedSideEffect: false,
        disposition: 'never_ran',
        remediation: {
          reason_code: 'unknown_tool',
          message: 'Use only a tool that is available in this conversation, or continue without a tool.',
          suggested_action: 'change_strategy',
        },
        admissionProvenance: admission,
      };
    }

    const preparationFailure = toolCall.tool_info.pre_dispatch_failure;
    if (preparationFailure !== undefined) {
      const policyBlocked = preparationFailure.kind === 'policy_blocked';
      return {
        toolCall,
        toolInfo,
        response: toolResultResponse({
          text: JSON.stringify({ error: preparationFailure.message }),
          isError: true,
        }),
        failure: true,
        completedAt: new Date().toISOString(),
        memoized: false,
        repeatCount: 1,
        blockedPrivateFallback: false,
        repeatedSideEffect: false,
        disposition: policyBlocked ? 'policy_blocked' : 'never_ran',
        remediation: policyBlocked
          ? {
              reason_code: 'tool_policy_blocked',
              message: 'Use a tool that is allowed in this conversation or change strategy.',
              suggested_action: 'change_strategy',
            }
          : {
              reason_code: 'tool_pre_dispatch_failed',
              message: 'The tool could not be prepared and was not executed. Retry once or choose another tool.',
              suggested_action: 'retry',
            },
        admissionProvenance: admission,
      };
    }

    // Sentinel: re-verify an approved Tier 3 call byte-for-byte immediately
    // before invocation. A failed verification blocks dispatch (policy_blocked)
    // and never records a side-effect attempt or memo entry.
    const sentinelVerificationError = await verifySentinelPreDispatch({
      toolCall,
      approvalDecisions,
      sentinel,
    });
    if (sentinelVerificationError !== undefined) {
      return {
        toolCall,
        toolInfo,
        response: toolResultResponse({
          text: JSON.stringify({ error: sentinelVerificationError }),
          isError: true,
        }),
        failure: true,
        completedAt: new Date().toISOString(),
        memoized: false,
        repeatCount: 1,
        blockedPrivateFallback: false,
        repeatedSideEffect: false,
        disposition: 'policy_blocked',
        remediation: {
          reason_code: 'sentinel_verification_failed',
          message: sentinelVerificationError,
          suggested_action: 'change_strategy',
        },
        admissionProvenance: admission,
      };
    }

    const invocationState = { started: false };
    let sideEffectAttemptKey: string | undefined;
    try {
      const args = parseToolArguments(toolCall.function.arguments);
      const approvalDecision = approvalDecisions.get(toolCall.id);
      if (approvalDecision?.status === 'deny') {
        return {
          toolCall,
          toolInfo,
          response: toolResultResponse({ text: deniedToolCallText(approvalDecision.reason), isError: true }),
          failure: true,
          completedAt: new Date().toISOString(),
          memoized: false,
          repeatCount: 1,
          blockedPrivateFallback: false,
          repeatedSideEffect: false,
          disposition: 'denied',
          remediation: undefined,
          admissionProvenance: admission,
        };
      }
      if (
        !approvalDecisions.has(toolCall.id) &&
        memoState.deniedApprovalIdentities.has(approvalGrantKey(toolCall.tool_info))
      ) {
        memoState.repeatedDeniedApproval = true;
        return {
          toolCall,
          toolInfo,
          response: toolResultResponse({
            text: JSON.stringify({
              error: 'This exact action was already denied in this turn. Change strategy or explain what you need.',
            }),
            isError: true,
          }),
          failure: true,
          completedAt: new Date().toISOString(),
          memoized: false,
          repeatCount: 1,
          blockedPrivateFallback: false,
          repeatedSideEffect: false,
          disposition: 'policy_blocked',
          remediation: {
            reason_code: 'repeated_denied_action',
            message: 'Change strategy or explain why a different action is needed.',
            suggested_action: 'change_strategy',
          },
          admissionProvenance: admission,
        };
      }
      if (
        (memoState.githubContentUnavailable || batchContainsGithubFileRead) &&
        toolInfo.toolSet.name.toLowerCase() !== 'github' &&
        hasGithubContentUrl(args)
      ) {
        return {
          toolCall,
          toolInfo,
          response: toolResultResponse({
            text: JSON.stringify({
              error:
                'Private repository web fallback blocked. Use the authenticated local checkout in the sandbox instead.',
            }),
            isError: true,
          }),
          failure: true,
          completedAt: new Date().toISOString(),
          memoized: false,
          repeatCount: 1,
          blockedPrivateFallback: true,
          repeatedSideEffect: false,
          disposition: 'policy_blocked',
          remediation: {
            reason_code: 'private_repository_fallback',
            message: 'Use the authenticated local checkout instead.',
            suggested_action: 'change_strategy',
          },
          admissionProvenance: admission,
        };
      }
      const shouldMemoize =
        toolCall.tool_info.effect === 'inspect' ||
        (toolCall.tool_info.effect === undefined && toolCall.tool_info.read_only_hint === true) ||
        isGithubFileRead(toolInfo.toolSet.name, toolInfo.originalToolName);
      const shouldReplayCompleted = shouldMemoize || toolCall.tool_info.effect === 'verify';
      const key = memoKey(
        toolInfo,
        args,
        toolCall.tool_info.effect,
        memoState.workspaceMutationEpoch,
        toolCall.tool_info.command_execution,
      );
      const dispatchId = `dispatch-${createHash('sha256')
        .update(JSON.stringify([threadId, toolCall.id, key]), 'utf8')
        .digest('hex')}`;
      const previous = shouldReplayCompleted ? memoState.entries.get(key) : undefined;
      if (previous !== undefined) {
        previous.count += 1;
        return {
          toolCall,
          toolInfo,
          response: previous.response,
          failure: previous.failure,
          completedAt: new Date().toISOString(),
          memoized: true,
          repeatCount: previous.count,
          blockedPrivateFallback: false,
          repeatedSideEffect: false,
          disposition: previous.disposition,
          remediation: previous.remediation,
          admissionProvenance: admission,
        };
      }
      const shouldTrackSideEffect =
        !shouldMemoize &&
        toolCall.tool_info.is_thread_creation !== true &&
        toolCall.tool_info.is_client_side !== true &&
        (toolCall.tool_info.is_approval_required !== true || approvalDecision?.status === 'allow');
      if (shouldTrackSideEffect) {
        const existingAttempt = existingSideEffectAttempt(memoState, key, toolInfo, args, toolCall.tool_info.effect);
        const attempts = existingAttempt.count;
        const preparedForThisDispatch = preparedSideEffectCalls?.callIds.has(toolCall.id) === true;
        const preparedKey = preparedSideEffectCalls?.keysByCallId.get(toolCall.id);
        if (preparedForThisDispatch && preparedKey !== key) {
          if (preparedKey !== undefined) {
            memoState.sideEffectAttempts.delete(preparedKey);
          }
          memoState.repeatedSideEffect = true;
          return {
            toolCall,
            toolInfo,
            response: toolResultResponse({
              text: JSON.stringify({
                error:
                  'A preceding workspace mutation did not complete as expected. This dependent action was not dispatched.',
              }),
              isError: true,
            }),
            failure: true,
            completedAt: new Date().toISOString(),
            memoized: false,
            repeatCount: 1,
            blockedPrivateFallback: false,
            repeatedSideEffect: true,
            disposition: 'policy_blocked',
            remediation: {
              reason_code: 'dependent_workspace_state_changed',
              message: 'Inspect the current workspace state before choosing another action.',
              suggested_action: 'inspect_state',
            },
            admissionProvenance: admission,
          };
        }
        if (attempts > 0 && !preparedForThisDispatch) {
          memoState.sideEffectAttempts.set(existingAttempt.key, attempts + 1);
          memoState.repeatedSideEffect = true;
          return {
            toolCall,
            toolInfo,
            response: toolResultResponse({
              text: JSON.stringify({
                error:
                  'This side-effecting action was already attempted. Its terminal state may be unknown; do not retry the identical action.',
              }),
              isError: true,
            }),
            failure: true,
            completedAt: new Date().toISOString(),
            memoized: false,
            repeatCount: attempts + 1,
            blockedPrivateFallback: false,
            repeatedSideEffect: true,
            disposition: 'outcome_unknown',
            remediation: {
              reason_code: 'repeated_side_effect',
              message: 'Establish whether the earlier attempt took effect before continuing.',
              suggested_action: 'inspect_state',
            },
            admissionProvenance: admission,
          };
        }
        if (preparedForThisDispatch && attempts === 0) {
          memoState.repeatedSideEffect = true;
          return {
            toolCall,
            toolInfo,
            response: toolResultResponse({
              text: JSON.stringify({
                error: 'The durable side-effect marker is missing. The action was not dispatched.',
              }),
              isError: true,
            }),
            failure: true,
            completedAt: new Date().toISOString(),
            memoized: false,
            repeatCount: 1,
            blockedPrivateFallback: false,
            repeatedSideEffect: true,
            disposition: 'policy_blocked',
            remediation: {
              reason_code: 'missing_execution_marker',
              message: 'Do not dispatch this action without a durable execution marker.',
              suggested_action: 'change_strategy',
            },
            admissionProvenance: admission,
          };
        }
        if (attempts === 0) {
          memoState.sideEffectAttempts.set(key, 1);
          sideEffectAttemptKey = key;
        } else {
          sideEffectAttemptKey = existingAttempt.key;
        }
        sideEffectAttemptKey = key;
      }
      const pending = shouldMemoize ? memoState.inflight.get(key) : undefined;
      if (pending !== undefined) {
        const shared = await awaitWithAbort({ operation: pending, signal });
        if (shared !== null) {
          shared.count += 1;
          return {
            toolCall,
            toolInfo,
            response: shared.response,
            failure: shared.failure,
            completedAt: new Date().toISOString(),
            memoized: true,
            repeatCount: shared.count,
            blockedPrivateFallback: false,
            repeatedSideEffect: false,
            disposition: shared.disposition,
            remediation: shared.remediation,
            admissionProvenance: admission,
          };
        }
      }
      // Phase-A reads share a bounded pool of dispatch permits; stateful calls
      // run one at a time in batch order and skip the limiter. The permit is
      // held only across the provider dispatch itself, and a holder never
      // waits on a waiter, so queued calls cannot deadlock. A call aborted
      // while queued never reaches invoke(), so the catch below records it as
      // never_ran.
      const readOnlyDispatch = isReadOnlyDispatch(toolCall);
      // Starts the provider call and marks invocationState synchronously, so
      // the catch path can tell a dispatch that never started (never_ran)
      // from one interrupted mid-flight (outcome_unknown). The per-call
      // deadline is applied by the caller via withCallTimeout so the raw
      // (untimed) provider promise stays observable for late-settlement
      // logging on the memoized path.
      const invoke = (): Promise<CallToolResponse> => {
        invocationState.started = true;
        return toolInfo.toolSet.callTool(
          {
            name: toolInfo.originalToolName,
            arguments: args,
          },
          approvalDecisions.get(toolCall.id),
          {
            admission_provenance: admission,
            dispatch_id: dispatchId,
            // the turn's abort signal reaches tools that do bounded
            // multi-phase work (run_code provisioning observes it).
            signal,
            ...(toolCall.tool_info.structured_edit_precondition === undefined
              ? {}
              : { structured_edit_precondition: toolCall.tool_info.structured_edit_precondition }),
          },
        );
      };
      // Dispatch through the Phase-A permit pool for reads; the abort-aware
      // acquire drops a queued waiter on abort so it never steals a permit
      // from a live call. Throws before any provider invocation when the turn
      // already aborted, so an aborted-queued call records never_ran without
      // dispatching a side effect the turn will never observe.
      //
      // The per-call deadline starts at provider invocation (not while queued
      // for a permit): it bounds the provider call, and the permit is released
      // when the timed wait settles, so a hung provider cannot hold its
      // Phase-A permit past the deadline and wedge the rest of the batch. The
      // raw (untimed) provider promise is returned alongside the timed wait so
      // the memoized path can log a late settlement without ever feeding it to
      // the memo or the turn result.
      const dispatch = async (): Promise<{
        raw: Promise<CallToolResponse>;
        timed: Promise<CallToolResponse>;
      }> => {
        throwIfSignalAborted(signal);
        const timeoutInput = {
          // the provisioning-sized deadline is scoped to sandbox/run_code alone.
          timeoutMs: isRunCodeToolCall(toolInfo) ? runCodeCallTimeoutMs : callTimeoutMs,
          toolName: toolCall.function.name,
          toolCallId: toolCall.id,
        };
        if (!readOnlyDispatch) {
          const raw = invoke();
          return { raw, timed: withCallTimeout(raw, timeoutInput) };
        }
        await dispatchLimiter.acquire(signal);
        const raw = invoke();
        const timed = withCallTimeout(raw, timeoutInput);
        // Release the permit when the timed wait settles, on success or
        // failure: a timeout rejects the race while the raw provider promise
        // may still hang, and the permit must not be held hostage by it. Both
        // branches share one callback; a bare `void timed.finally(...)` would
        // surface an unhandled rejection on the failure path.
        const releasePermit = (): void => {
          dispatchLimiter.release();
        };
        void timed.then(releasePermit, releasePermit);
        return { raw, timed };
      };
      let response: Awaited<ReturnType<MappedMCPTool['toolSet']['callTool']>>;
      let entry: MemoEntry | null = null;
      if (!shouldMemoize) {
        response = await awaitWithAbort({ operation: dispatch().then(({ timed }) => timed), signal });
      } else {
        const pendingDispatch = dispatch();
        const timedPromise = pendingDispatch.then(({ timed }) => timed);
        const invocation: Promise<MemoEntry | null> = timedPromise.then(
          result => {
            if (!isCallToolResponseResult(result)) {
              return null;
            }
            return {
              response: result,
              failure: isGithubFileContentUnavailable(result),
              count: 1,
              disposition: result.result.isError === true ? 'executed_nonzero' : 'executed_ok',
              remediation: undefined,
            };
          },
          (error: unknown) => {
            if (error instanceof ToolCallTimeoutError) {
              // The turn stopped waiting, but the provider call may still
              // settle. Observe the raw promise only to log the late
              // settlement at debug; it must never feed the memo or the turn
              // result.
              void pendingDispatch.then(
                ({ raw }) => {
                  void raw.then(
                    () => {
                      logger?.debug('Tool provider settled after the dispatch deadline', {
                        toolCallId: toolCall.id,
                        toolName: toolCall.function.name,
                        outcome: 'resolved',
                      });
                    },
                    () => {
                      logger?.debug('Tool provider settled after the dispatch deadline', {
                        toolCallId: toolCall.id,
                        toolName: toolCall.function.name,
                        outcome: 'rejected',
                      });
                    },
                  );
                },
                () => {
                  // Dispatch never produced a provider promise (aborted while
                  // queued); nothing to observe late.
                },
              );
            }
            throw error;
          },
        );
        memoState.inflight.set(key, invocation);
        try {
          entry = await awaitWithAbort({ operation: invocation, signal });
        } finally {
          // Detach the timed-out provider promise from memo writes: the
          // finally drops the inflight entry and the throw below skips the
          // memo write, so a late provider response never populates the memo
          // and a retry re-dispatches instead of replaying a result the turn
          // never saw.
          memoState.inflight.delete(key);
        }
        response = entry === null ? await timedPromise : entry.response;
      }
      if (toolCall.tool_info.effect === 'verify' && isCallToolResponseResult(response)) {
        const failed = response.result.isError === true;
        memoState.entries.set(key, {
          response,
          failure: failed,
          count: 1,
          disposition: failed ? 'executed_nonzero' : 'executed_ok',
          remediation: undefined,
        });
      }
      const unavailable = isGithubFileContentUnavailable(response);
      if (unavailable) {
        memoState.githubContentUnavailable = true;
      }
      if (shouldMemoize && entry !== null) {
        memoState.entries.set(key, entry);
      }
      // A definite outcome (the provider answered, whether success or an
      // observed non-zero exit) resolves the durability marker. So does a
      // known pre-dispatch outcome such as authRequired: the host checks
      // credentials before calling the remote operation and can say for
      // certain the tool never ran, so an identical retry after the user
      // authenticates is not a stale-marker replay. Only a dispatch whose
      // result was never observed (the invocation threw below, e.g. a
      // provider disconnect or lost sandbox) should leave the marker in
      // place to block an identical retry as outcome_unknown.
      if (sideEffectAttemptKey !== undefined && (isCallToolResponseResult(response) || isAuthRequired(response))) {
        memoState.sideEffectAttempts.delete(sideEffectAttemptKey);
      }
      if (
        isCallToolResponseResult(response) &&
        ((response.result.isError !== true &&
          (toolCall.tool_info.effect === 'edit' || toolCall.tool_info.effect === 'commit')) ||
          toolCall.tool_info.effect === 'execute')
      ) {
        memoState.workspaceMutationEpoch += 1;
      }
      return {
        toolCall,
        toolInfo,
        response,
        failure: unavailable,
        completedAt: new Date().toISOString(),
        memoized: false,
        repeatCount: 1,
        blockedPrivateFallback: false,
        repeatedSideEffect: false,
        disposition:
          approvalDecisions.get(toolCall.id)?.status === 'deny'
            ? 'denied'
            : isCallToolResponseResult(response) && response.result.isError === true
              ? 'executed_nonzero'
              : isCallToolResponseResult(response)
                ? 'executed_ok'
                : 'never_ran',
        remediation: isAuthRequired(response)
          ? {
              reason_code: 'authentication_required',
              message: 'Authenticate the connector, then retry the tool call.',
              suggested_action: 'authenticate',
            }
          : undefined,
        admissionProvenance: admission,
      };
    } catch (error) {
      const implementationPlanBlocked = error instanceof ImplementationPlanAdmissionBlockedError;
      const structuredEditBlocked = error instanceof StructuredEditPreconditionBlockedError;
      const policyBlocked = error instanceof ToolPolicyBlockedError;
      const failedBeforeDispatch = error instanceof ToolPreDispatchError;
      // A call that never reached the provider (blocked, pre-dispatch
      // failure, abort or timeout while queued) performed no side effect, so
      // its durable marker is released and an identical retry is not
      // permanently blocked. Only a dispatch whose result was never observed
      // after it started keeps the marker to block the retry as
      // outcome_unknown.
      if ((policyBlocked || failedBeforeDispatch || !invocationState.started) && sideEffectAttemptKey !== undefined) {
        memoState.sideEffectAttempts.delete(sideEffectAttemptKey);
      }
      return {
        toolCall,
        toolInfo,
        response: toolResultResponse({
          text: JSON.stringify({ error: error instanceof Error ? error.message : 'Tool execution failed' }),
          isError: true,
        }),
        failure: true,
        completedAt: new Date().toISOString(),
        memoized: false,
        repeatCount: 1,
        blockedPrivateFallback: false,
        repeatedSideEffect: false,
        disposition: policyBlocked
          ? 'policy_blocked'
          : failedBeforeDispatch || !invocationState.started
            ? 'never_ran'
            : 'outcome_unknown',
        remediation: implementationPlanBlocked
          ? {
              reason_code: 'implementation_plan_admission_blocked',
              message: error.message,
              suggested_action: 'request_approval',
            }
          : structuredEditBlocked
            ? {
                reason_code: 'structured_edit_stale',
                message: error.message,
                suggested_action: 'change_strategy',
              }
            : policyBlocked
              ? {
                  reason_code: 'tool_policy_blocked',
                  message: 'Use a tool that is allowed in this conversation or change strategy.',
                  suggested_action: 'change_strategy',
                }
              : failedBeforeDispatch
                ? {
                    reason_code: 'tool_pre_dispatch_failed',
                    message: 'The tool could not be prepared and was not executed. Retry once or choose another tool.',
                    suggested_action: 'retry',
                  }
                : invocationState.started
                  ? {
                      reason_code: 'execution_interrupted',
                      message: 'Inspect the target state before deciding whether the action is safe to retry.',
                      suggested_action: 'inspect_state',
                    }
                  : {
                      reason_code: 'invalid_tool_arguments',
                      message: 'Correct the tool arguments before retrying.',
                      suggested_action: 'change_strategy',
                    },
        admissionProvenance: admission,
      };
    }
  };

  // A model may emit several edits in one response. Running state-changing
  // calls concurrently races file preconditions and forces multiple sandbox
  // bridges to contend for the same checkout. Dispatch in two levels instead:
  //
  // Phase A (reads): every read-only call dispatches concurrently through the
  // per-batch permit limiter, so independent inspections overlap in time
  // without an unbounded Promise.all stampede.
  //
  // Phase B (stateful): every other call then runs sequentially in original
  // batch order, preserving the preparedKey !== key dependent-precondition
  // guard, the workspaceMutationEpoch projection, and the sandbox
  // mutation-lock semantics. Phase B starts only after Phase A settles, so
  // reads in a mixed batch observe pre-side-effect state.
  //
  // Outcomes are slotted back into input order either way. The level-based
  // shape leaves room for a future arg-placeholder DAG to slot in as
  // additional levels between these two.
  const readPhase: { index: number; toolCall: InternalEnrichedToolCall }[] = [];
  const statefulPhase: { index: number; toolCall: InternalEnrichedToolCall }[] = [];
  assistantMessage.tool_calls.forEach((toolCall, index) => {
    if (isReadOnlyDispatch(toolCall)) {
      readPhase.push({ index, toolCall });
    } else {
      statefulPhase.push({ index, toolCall });
    }
  });
  const outcomes = new Map<number, ToolCallExecutionOutcome>();
  await Promise.all(
    readPhase.map(({ index, toolCall }) =>
      executeOne(toolCall).then(outcome => {
        outcomes.set(index, outcome);
      }),
    ),
  );
  for (const { index, toolCall } of statefulPhase) {
    outcomes.set(index, await executeOne(toolCall));
  }
  const results = assistantMessage.tool_calls.map((_, index) => {
    const outcome = outcomes.get(index);
    if (outcome === undefined) {
      throw new Error('unreachable: scheduler did not produce an outcome for every tool call');
    }
    return outcome;
  });
  // Sentinel: record Tier 3 carded outcomes. Auto-denied calls were recorded
  // at classify time; 'approved'/'denied' land here once the user decided.
  if (sentinel?.services.audit !== null && sentinel?.services.audit !== undefined) {
    const audit = sentinel.services.audit;
    for (const toolCall of assistantMessage.tool_calls ?? []) {
      const info = toolCall.tool_info;
      if (info.tier !== 3 || info.tier3_card === null) {
        continue;
      }
      const status = approvalDecisions.get(toolCall.id)?.status;
      if (status !== 'allow' && status !== 'deny') {
        continue;
      }
      await audit.record({
        tenant_id: sentinel.identity.tenant_id,
        created_by: sentinel.identity.created_by,
        conversation_id: sentinel.identity.conversation_id,
        tier: 3,
        tool_name: info.original_tool_name,
        description: info.tier3_card?.plain_what ?? info.original_tool_name,
        outcome: status === 'allow' ? 'approved' : 'denied',
        auto_deny_reason: null,
      });
    }
  }
  for (const {
    toolCall,
    toolInfo,
    response,
    failure,
    completedAt,
    memoized,
    repeatCount,
    blockedPrivateFallback,
    repeatedSideEffect,
    disposition,
    remediation: resultRemediation,
    admissionProvenance: resultAdmissionProvenance,
  } of results) {
    if (isCallToolResponseCreateSubAgent(response)) {
      createThreadEvents.push({
        type: InternalEventType.AGENT_CREATE_SUBAGENT,
        thread_id: threadId,
        tool_call_id: toolCall.id,
        agent_info: response.createSubAgent,
      });
      continue;
    }

    if (isAuthRequired(response)) {
      authRequirementInfo.push(response.authRequired);
      // Must still emit a tool result so every tool_call in the assistant message has a
      // matching tool_result in context; otherwise the LLM API rejects the conversation.
      toolMessages.push({
        message: {
          role: 'tool',
          tool_call_id: toolCall.id,
          content: 'Waiting for user to authenticate. Please try again 1 time.',
        },
        rawContent: 'Waiting for user to authenticate. Please try again 1 time.',
        toolCallInfo: toolCall.tool_info,
        screen: undefined,
        failure: true,
        info: toolInfo,
        isStructuredContent: false,
        completedAt,
        memoized,
        replayKind:
          memoized && toolCall.tool_info.effect === 'verify' ? 'verification' : memoized ? 'inspection' : undefined,
        repeatCount,
        blockedPrivateFallback,
        repeatedSideEffect,
        verificationReceiptCandidate: undefined,
        disposition,
        remediation: resultRemediation,
        admissionProvenance: resultAdmissionProvenance,
      });
      continue;
    }

    if (isApprovalRequiredResponse(response)) {
      approvalRequiredToolCalls.push(toolCall);
      continue;
    }

    if (isClientSideToolRequiredResponse(response)) {
      clientSideToolCalls.push(toolCall);
      continue;
    }

    const { result, wasInitialized } = response;

    let content: string;
    let isStructuredContent = false;
    if (result.isError) {
      // Error payloads are structured: unwrap a JSON error envelope to the parsed
      // object instead of double-encoding the content blocks, and degrade plain
      // text to a { error: text } object. The model gets a JSON payload either way.
      const errorText = Array.isArray(result.content)
        ? result.content
            .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
            .map(c => c.text)
            .join('\n')
        : typeof result.content === 'string'
          ? result.content
          : JSON.stringify(result.content);
      let errorPayload: unknown;
      try {
        errorPayload = JSON.parse(errorText);
      } catch {
        errorPayload = { error: errorText };
      }
      content = JSON.stringify(errorPayload);
      isStructuredContent = true;
    } else if (result.structuredContent) {
      isStructuredContent = true;
      content = JSON.stringify(result.structuredContent);
    } else if (Array.isArray(result.content)) {
      const textContent = result.content
        .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
        .map(c => c.text)
        .join('\n');
      content = textContent || JSON.stringify(result.content);
    } else {
      content = JSON.stringify(result.content);
    }

    toolMessages.push({
      message: { role: 'tool', tool_call_id: toolCall.id, content },
      rawContent: content,
      toolCallInfo: toolCall.tool_info,
      screen: undefined,
      failure: failure || result.isError === true,
      info: toolInfo,
      isStructuredContent,
      completedAt,
      memoized,
      replayKind:
        memoized && toolCall.tool_info.effect === 'verify' ? 'verification' : memoized ? 'inspection' : undefined,
      repeatCount,
      blockedPrivateFallback,
      repeatedSideEffect,
      verificationReceiptCandidate: response.verificationReceiptCandidate,
      disposition,
      remediation: resultRemediation,
      admissionProvenance: resultAdmissionProvenance,
    });
    if (wasInitialized) {
      initializationInfo.push(wasInitialized);
    }
    if (response.sandboxCreated && response.sandboxInfo) {
      sandboxCreated = response.sandboxInfo;
    }
    if (response.events?.length) {
      passthroughEvents.push(...response.events);
    }
  }

  return {
    toolCallResults: toolMessages,
    initializationInfo,
    createThreadEvents,
    sandboxCreated,
    authRequirementInfo,
    approvalRequiredToolCalls,
    clientSideToolCalls,
    events: passthroughEvents,
  };
}

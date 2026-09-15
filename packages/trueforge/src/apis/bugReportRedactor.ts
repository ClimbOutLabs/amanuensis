/**
 * Pure assembly + redaction logic for the per-session bug-report bundle.
 *
 * Allowlist, not denylist: every field that reaches {@link BugReportBundle} is explicitly read
 * off a known-safe path (event `type`, tool name/effect, disposition, bounded reason codes,
 * counts, timestamps). Free-text error strings — tool-response `remediation.message`, turn
 * `state.message`, and memory-recall `stats.reason` — are never read into the bundle: they are
 * populated from unconstrained caught-error / provider / sub-agent text, so each recorded error
 * carries only a bounded, host-owned code (a `reason_code`, a disposition, a cancellation reason,
 * a recall outcome) plus a fixed host-authored message derived from that code (see
 * {@link toolResponseErrorMessage}), never the raw source string. Message text, memory-recall
 * `injected_block`, learned-profile `previous`/`current`, tool-call arguments, and tool-response
 * `content` are never read for their string value — only `estimateCharCount` touches message
 * text, and it returns a number, never the text. Anything not explicitly handled by {@link reduceTurnEvents}
 * falls through to a bare `{ type }` marker, so an unrecognized or malformed event degrades to
 * "an event of this type happened" rather than being echoed verbatim.
 *
 * `events` is accepted as `unknown` per item (not the SDK's typed `SessionEvent` union) so this
 * module has no dependency on how the caller fetched them — the redaction guarantee holds for
 * any object shape, including malformed or legacy rows.
 */
import type { AbnormalHandoffCause } from '@truefoundry/trueforge-core/core';
import { AbnormalHandoffCauseSchema, ToolOutputTransformSchema } from '@truefoundry/trueforge-core/core';
import type {
  AppBugReportBundle,
  BugReportBundle,
  BugReportChat,
  BugReportChatMessage,
  BugReportConfigFlags,
  BugReportError,
  BugReportTraceEvent,
  BugReportTurnTrace,
} from '../schemas/bugReport';
import { BUG_REPORT_SCHEMA_VERSION } from '../schemas/bugReport';
import type { BuildIdentity } from '../schemas/capability';

/** Newest-first cap on the bundle's top-level `recent_errors` list. */
const MAX_RECENT_ERRORS = 20;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Bracket-access one field of a loosely-typed record (avoids `noPropertyAccessFromIndexSignature`). */
function field(record: Record<string, unknown>, key: string): unknown {
  return record[key];
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function parseIsoMs(value: unknown): number | undefined {
  const iso = asString(value);
  if (iso === undefined) {
    return undefined;
  }
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * Size of a message-shaped `content` value without reading it into the bundle. Handles a plain
 * string, an array of content parts (text / file / anything else), or an unexpected shape —
 * every branch returns a count, never the underlying text.
 */
function estimateCharCount(content: unknown): number {
  if (content === null || content === undefined) {
    return 0;
  }
  if (typeof content === 'string') {
    return content.length;
  }
  if (Array.isArray(content)) {
    return content.reduce((total: number, part: unknown) => total + estimateCharCount(part), 0);
  }
  if (isRecord(content)) {
    const text = asString(field(content, 'text'));
    if (text !== undefined) {
      return text.length;
    }
    const data = asString(field(content, 'data'));
    if (data !== undefined) {
      return data.length;
    }
    // Unknown part shape: fall back to its serialized length. This still emits only a number.
    return JSON.stringify(content).length;
  }
  // Remaining primitives (number/boolean/bigint) stringify meaningfully; anything else (a
  // function or symbol) has no textual content worth counting.
  if (typeof content === 'number' || typeof content === 'boolean' || typeof content === 'bigint') {
    return String(content).length;
  }
  return 0;
}

/** What is known about a tool call from the `model.message` that requested it. */
interface ToolCallContext {
  name?: string | undefined;
  effect?: string | undefined;
  startedAtMs?: number | undefined;
  intent?: string | undefined;
}

const MAX_INTENT_CHARS = 200;

/**
 * `id` plus the allowlisted `tool_info` fields off one `EnrichedToolCall`. The arguments are
 * read for exactly one field, `intent`, and only when the reporter included the chat: it is the
 * model's own one-line description of the step, the same text the chat shows as the step title,
 * and belongs with the messages rather than with the arguments it sits beside.
 */
function toolCallInfo(
  call: unknown,
  { includeIntent }: { includeIntent: boolean },
): { id: string; name: string | undefined; effect: string | undefined; intent: string | undefined } | undefined {
  if (!isRecord(call)) {
    return undefined;
  }
  const id = asString(field(call, 'id'));
  if (id === undefined) {
    return undefined;
  }
  const toolInfo = asRecord(field(call, 'tool_info'));
  const fn = asRecord(field(call, 'function'));
  const name = toolInfo ? asString(field(toolInfo, 'name')) : undefined;
  return {
    id,
    name: name ?? (fn ? asString(field(fn, 'name')) : undefined),
    effect: toolInfo ? asString(field(toolInfo, 'effect')) : undefined,
    intent: includeIntent ? readIntent(fn ? field(fn, 'arguments') : undefined) : undefined,
  };
}

function readIntent(rawArguments: unknown): string | undefined {
  if (typeof rawArguments !== 'string') {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(rawArguments);
    const intent = isRecord(parsed) ? asString(field(parsed, 'intent')) : undefined;
    return intent === undefined || intent.trim() === '' ? undefined : intent.slice(0, MAX_INTENT_CHARS);
  } catch {
    return undefined;
  }
}

/**
 * The exit code a sandbox command reported, read without keeping the result. A v2 event wraps
 * the result in an envelope under `result`; a legacy `tool.response` stores the result itself.
 * The text is looked at only for a numeric `response.exitCode`.
 */
function toolResultExitCode(content: unknown): number | undefined {
  if (typeof content !== 'string') {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }
  const envelope = asRecord(parsed);
  const isEnvelope =
    envelope !== undefined &&
    field(envelope, 'schema_version') !== undefined &&
    field(envelope, 'result') !== undefined;
  let result: unknown = isEnvelope ? field(envelope, 'result') : parsed;
  if (typeof result === 'string') {
    try {
      result = JSON.parse(result);
    } catch {
      return undefined;
    }
  }
  const response = isRecord(result) ? asRecord(field(result, 'response')) : undefined;
  const exitCode = response ? asNumber(field(response, 'exitCode')) : undefined;
  return exitCode !== undefined && Number.isInteger(exitCode) ? exitCode : undefined;
}

/**
 * Fixed, host-authored diagnostic for a failed tool response, derived only from the bounded
 * `disposition` enum — never from the free-text `remediation.message`, which is populated from
 * unconstrained sub-agent / provider failure text (e.g. `chunk.error`) and could otherwise carry
 * a path, URL, credential, or user-typed denial reason into the bundle. The machine-readable
 * `reason_code` still travels in the error's `code`.
 */
function toolResponseErrorMessage(disposition: string | undefined): string {
  switch (disposition) {
    case 'denied':
      return 'The tool call was denied.';
    case 'policy_blocked':
      return 'The tool call was blocked by policy.';
    case 'never_ran':
      return 'The tool call did not run.';
    case 'outcome_unknown':
      return 'The tool call outcome could not be determined.';
    case 'executed_nonzero':
      return 'The tool ran and reported a failure.';
    default:
      return 'The tool call reported an error.';
  }
}

interface TurnReduction {
  events: BugReportTraceEvent[];
  errors: BugReportError[];
}

/** Reduces one turn's raw events (oldest first) to structural trace entries plus any errors found. */
function reduceTurnEvents(
  turnId: string,
  rawEvents: readonly unknown[],
  { includeIntent }: { includeIntent: boolean },
): TurnReduction {
  const toolCalls = new Map<string, ToolCallContext>();
  const trace: BugReportTraceEvent[] = [];
  const errors: BugReportError[] = [];
  let turnStartedAtMs: number | undefined;

  const recordError = (eventType: string, code: string | null, message: string): void => {
    errors.push({ turn_id: turnId, event_type: eventType, code, message });
  };
  // Every entry gets its offset from the turn start, so a reader can see where time went.
  const push = (entry: BugReportTraceEvent, createdAt: unknown): void => {
    const atMs = parseIsoMs(createdAt);
    trace.push(
      turnStartedAtMs !== undefined && atMs !== undefined
        ? { ...entry, at_ms: Math.max(0, atMs - turnStartedAtMs) }
        : entry,
    );
  };

  for (const raw of rawEvents) {
    const event = isRecord(raw) ? raw : {};
    const type = asString(field(event, 'type')) ?? 'unknown';
    const createdAt = field(event, 'created_at');

    switch (type) {
      case 'turn.created': {
        turnStartedAtMs = parseIsoMs(createdAt);
        push({ type }, createdAt);
        for (const rawInputItem of asArray(field(event, 'input')) ?? []) {
          const inputItem = asRecord(rawInputItem);
          if (inputItem === undefined) {
            continue;
          }
          const inputType = asString(field(inputItem, 'type'));
          if (inputType === 'user.message') {
            push(
              { type: inputType, role: 'user', char_count: estimateCharCount(field(inputItem, 'content')) },
              createdAt,
            );
          } else if (inputType === 'user.tool_response') {
            push(
              { type: inputType, role: 'tool_client', char_count: estimateCharCount(field(inputItem, 'content')) },
              createdAt,
            );
          } else if (inputType === 'user.tool_approval') {
            const approvalRecord = asRecord(field(inputItem, 'approval'));
            const approval = approvalRecord ? asString(field(approvalRecord, 'status')) : undefined;
            push({ type: inputType, ...(approval !== undefined ? { outcome: approval } : {}) }, createdAt);
          } else if (inputType !== undefined) {
            push({ type: inputType }, createdAt);
          }
        }
        break;
      }

      case 'model.message': {
        const toolNames: string[] = [];
        // A sub-agent's intents are its instructions, which the chat transcript leaves out too.
        const intentAllowed = includeIntent && isRootThread(event);
        for (const call of asArray(field(event, 'tool_calls')) ?? []) {
          const info = toolCallInfo(call, { includeIntent: intentAllowed });
          if (info !== undefined) {
            toolCalls.set(info.id, { name: info.name, effect: info.effect, intent: info.intent });
            toolNames.push(info.name ?? 'unknown');
          }
        }
        const finishReason = asString(field(event, 'finish_reason'));
        const usage = asRecord(field(event, 'usage'));
        const outputTokens = usage ? asNumber(field(usage, 'output_tokens')) : undefined;
        push(
          {
            type,
            role: 'assistant',
            char_count: estimateCharCount(field(event, 'content')),
            ...(toolNames.length > 0 ? { tool_names: toolNames } : {}),
            ...(finishReason !== undefined ? { finish_reason: finishReason } : {}),
            ...(outputTokens !== undefined ? { counts: { output_tokens: outputTokens } } : {}),
          },
          createdAt,
        );
        break;
      }

      case 'tool.execution_started': {
        const toolCallId = asString(field(event, 'tool_call_id'));
        const toolName = asString(field(event, 'tool_name'));
        const startedAtMs = parseIsoMs(field(event, 'created_at'));
        if (toolCallId !== undefined) {
          const existing = toolCalls.get(toolCallId) ?? {};
          toolCalls.set(toolCallId, {
            name: existing.name ?? toolName,
            effect: existing.effect,
            intent: existing.intent,
            startedAtMs,
          });
        }
        const started = toolCallId !== undefined ? toolCalls.get(toolCallId) : undefined;
        push(
          {
            type,
            ...(toolName !== undefined ? { tool_name: toolName } : {}),
            ...(started?.intent !== undefined ? { intent: started.intent } : {}),
          },
          createdAt,
        );
        break;
      }

      case 'tool.response':
      case 'tool.response.v2': {
        const toolCallId = asString(field(event, 'tool_call_id'));
        const context = toolCallId !== undefined ? toolCalls.get(toolCallId) : undefined;
        const completedAtMs = parseIsoMs(createdAt);
        const durationMs =
          context?.startedAtMs !== undefined && completedAtMs !== undefined
            ? Math.max(0, completedAtMs - context.startedAtMs)
            : undefined;
        // v2 carries an explicit disposition; the legacy v1 shape only means "the call completed".
        const outcome = asString(field(event, 'disposition')) ?? 'completed';
        const remediation = asRecord(field(event, 'remediation'));
        const reasonCode = remediation ? asString(field(remediation, 'reason_code')) : undefined;
        // The host's own record of having changed the text; never inferred from the text.
        const transform = ToolOutputTransformSchema.safeParse(field(event, 'output_transform'));
        const outputTransform = transform.success ? transform.data : undefined;
        const facts = {
          guardReplaced: outputTransform === 'replaced',
          exitCode: toolResultExitCode(field(event, 'content')),
        };
        // Read only the host-owned `reason_code`; the free-text `remediation.message` is never
        // read: it is built from unconstrained `chunk.error`, so the emitted message is fixed
        // host text. Any disposition short of a clean run is an error worth listing, whether or
        // not the host attached a remediation; a legacy event has no disposition, so its exit
        // code is what says it failed.
        const failedDisposition = outcome !== 'executed_ok' && outcome !== 'completed';
        const failedExit = facts.exitCode !== undefined && facts.exitCode !== 0;
        const errorCode = facts.guardReplaced ? 'output_too_large' : (reasonCode ?? null);
        const errorMessage = facts.guardReplaced
          ? 'The tool output was too large and the host replaced it with guidance; the model never saw the result.'
          : failedDisposition || remediation !== undefined
            ? toolResponseErrorMessage(outcome)
            : failedExit
              ? toolResponseErrorMessage('executed_nonzero')
              : undefined;

        push(
          {
            type,
            ...(context?.name !== undefined ? { tool_name: context.name } : {}),
            ...(context?.effect !== undefined ? { effect: context.effect } : {}),
            outcome,
            ...(durationMs !== undefined ? { duration_ms: durationMs } : {}),
            ...(facts.exitCode !== undefined ? { exit_code: facts.exitCode } : {}),
            ...(outputTransform !== undefined ? { output_transform: outputTransform } : {}),
            ...(context?.intent !== undefined ? { intent: context.intent } : {}),
            ...(errorMessage !== undefined ? { error: { code: errorCode, message: errorMessage } } : {}),
          },
          createdAt,
        );
        if (errorMessage !== undefined) {
          recordError(type, errorCode, errorMessage);
        }
        break;
      }

      case 'aman.memory.recall': {
        const stats = asRecord(field(event, 'stats')) ?? {};
        const sweep = asRecord(field(event, 'sweep')) ?? {};
        const screen = asRecord(field(event, 'screen'));
        const outcome = asString(field(stats, 'outcome'));
        const budgetReason = asString(field(stats, 'budget_reason'));
        const unreachableCode = asString(field(sweep, 'unreachable_code'));
        push(
          {
            type,
            ...(outcome !== undefined ? { outcome } : {}),
            ...(budgetReason === 'normal' || budgetReason === 'post_compaction' ? { budget_reason: budgetReason } : {}),
            counts: {
              items: asNumber(field(stats, 'items')) ?? 0,
              entities: asNumber(field(stats, 'entities')) ?? 0,
              dropped_over_budget: asNumber(field(stats, 'dropped_over_budget')) ?? 0,
              dropped_below_threshold: asNumber(field(stats, 'dropped_below_threshold')) ?? 0,
              estimated_tokens: asNumber(field(stats, 'estimated_tokens')) ?? 0,
              recall_ms: asNumber(field(stats, 'recall_ms')) ?? 0,
              sweep_verified: asNumber(field(sweep, 'verified')) ?? 0,
              sweep_retried: asNumber(field(sweep, 'retried')) ?? 0,
              sweep_abandoned: asNumber(field(sweep, 'abandoned')) ?? 0,
              sweep_pending: asNumber(field(sweep, 'pending')) ?? 0,
              sweep_unreachable: asNumber(field(sweep, 'unreachable')) ?? 0,
              ...(screen !== undefined ? { screen_withheld: asNumber(field(screen, 'withheld')) ?? 0 } : {}),
            },
            ...(unreachableCode !== undefined ? { sweep_unreachable_code: unreachableCode } : {}),
          },
          createdAt,
        );
        if (outcome === 'timeout' || outcome === 'error') {
          // Drop `stats.reason`: it embeds arbitrary caught-error text, for example
          // `recall threw unexpectedly: ${error.message}`. The bounded outcome is the code.
          recordError(type, outcome, outcome === 'timeout' ? 'Memory recall timed out.' : 'Memory recall failed.');
        }
        break;
      }

      case 'aman.profile.learned': {
        push({ type, counts: { revision: asNumber(field(event, 'revision')) ?? 0 } }, createdAt);
        break;
      }

      case 'thread.created': {
        push({ type }, createdAt);
        break;
      }

      case 'thread.done': {
        const state = asRecord(field(event, 'state'));
        const status = state ? asString(field(state, 'status')) : undefined;
        push({ type, ...(status !== undefined ? { outcome: status } : {}) }, createdAt);
        break;
      }

      case 'agent.context.compaction': {
        // Counts and a bounded mode label only, never the summary text (see
        // ContextCompactionEventSchema in trueforge-core).
        const mode = asString(field(event, 'mode'));
        const outcome = asString(field(event, 'outcome'));
        const tokensBefore = asNumber(field(event, 'tokens_before'));
        const tokensAfter = asNumber(field(event, 'tokens_after'));
        const summaryChars = asNumber(field(event, 'summary_chars'));
        push(
          {
            type,
            ...(mode === 'coding' || mode === 'conversation' ? { mode } : {}),
            ...(outcome !== undefined ? { outcome } : {}),
            counts: {
              ...(tokensBefore !== undefined ? { tokens_before: tokensBefore } : {}),
              ...(tokensAfter !== undefined ? { tokens_after: tokensAfter } : {}),
              ...(summaryChars !== undefined ? { summary_chars: summaryChars } : {}),
            },
          },
          createdAt,
        );
        break;
      }

      case 'mcp.initialize':
      case 'mcp.auth_required': {
        push({ type, counts: { mcp_servers: (asArray(field(event, 'mcp_servers')) ?? []).length } }, createdAt);
        break;
      }

      case 'sandbox.created': {
        push({ type }, createdAt);
        break;
      }

      case 'document.ingestion': {
        // file_name/staged_path/issue are the attachment's own name and free-text extraction
        // detail, so they stay out of the bundle on the same allowlist basis as tool-call
        // arguments and other free text (see the module doc); `method` is likewise dropped as
        // low-value, unbounded text. Only the lifecycle phase, page count and duration remain.
        const phase = asString(field(event, 'phase'));
        const pageCount = asNumber(field(event, 'page_count'));
        const elapsedMs = asNumber(field(event, 'elapsed_ms'));
        push(
          {
            type,
            ...(phase !== undefined ? { outcome: phase } : {}),
            ...(elapsedMs !== undefined ? { duration_ms: elapsedMs } : {}),
            ...(pageCount !== undefined ? { counts: { page_count: pageCount } } : {}),
          },
          createdAt,
        );
        break;
      }

      case 'tool.approval_required':
      case 'tool.response_required': {
        push({ type, counts: { pending_tool_calls: (asArray(field(event, 'tool_calls')) ?? []).length } }, createdAt);
        break;
      }

      case 'turn.done': {
        const state = asRecord(field(event, 'state'));
        const status = state ? asString(field(state, 'status')) : undefined;
        const metrics = state ? asRecord(field(state, 'metrics')) : undefined;
        const pendingActions = state ? (asArray(field(state, 'required_actions')) ?? []).length : 0;
        const totalTokens = metrics ? asNumber(field(metrics, 'total_tokens')) : undefined;
        push(
          {
            type,
            ...(status !== undefined ? { outcome: status } : {}),
            counts: {
              pending_actions: pendingActions,
              ...(totalTokens !== undefined ? { total_tokens: totalTokens } : {}),
            },
          },
          createdAt,
        );
        if (status === 'error') {
          // Drop `state.message`: it is built from arbitrary `caughtError.message` /
          // `root_agent_error.error`. The handoff cause is a bounded host enum, so it is the
          // code, and the message is fixed host text for that cause.
          const cause = turnHandoffCause(state);
          recordError(type, cause ?? null, turnErrorMessage(cause));
        } else if (status === 'cancelled') {
          // `state.reason` is a bounded `CancellationReason` enum (host-owned) — keep it as the
          // code, but the message stays fixed host text rather than interpolating any raw string.
          const reason = state ? asString(field(state, 'reason')) : undefined;
          recordError(type, reason ?? null, 'The turn was cancelled.');
        }
        break;
      }

      default: {
        push({ type }, createdAt);
      }
    }
  }

  return { events: trace, errors };
}

/**
 * The host's own reason for an abnormal end, when the turn recorded one. Only a value from the
 * host's cause enum is a code; a malformed or legacy row yields no code, so free text never
 * reaches the bundle through this field.
 */
function turnHandoffCause(state: Record<string, unknown> | undefined): AbnormalHandoffCause | undefined {
  const handoff = state ? asRecord(field(state, 'handoff')) : undefined;
  const parsed = AbnormalHandoffCauseSchema.safeParse(handoff ? field(handoff, 'cause') : undefined);
  return parsed.success ? parsed.data : undefined;
}

function turnErrorMessage(cause: AbnormalHandoffCause | undefined): string {
  switch (cause) {
    case 'iteration_limit':
      return 'The turn ended because it reached the per-turn step limit.';
    case 'loop_detected':
      return 'The turn ended because the agent was stuck repeating itself.';
    case 'client_cancelled':
    case 'server_cancelled':
      return 'The turn ended because it was cancelled.';
    case 'fatal_error':
      return 'The turn ended with an unrecoverable error in the host or the model request.';
    default:
      return 'The turn ended with an error.';
  }
}

function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * One plain line per turn, written by the host from the structure alone, so the top of the
 * report says what happened before anyone reads the trace: what came in, how many model steps,
 * which tools ran and how they ended, and how the turn stopped.
 */
function summarizeTurn(index: number, reduced: TurnReduction): string {
  const events = reduced.events;
  const userChars = events.filter(event => event.type === 'user.message').reduce((n, e) => n + (e.char_count ?? 0), 0);
  const modelSteps = events.filter(event => event.type === 'model.message');
  const assistantChars = modelSteps.reduce((n, e) => n + (e.char_count ?? 0), 0);
  const toolRuns = events.filter(event => event.type === 'tool.response' || event.type === 'tool.response.v2');
  const byTool = new Map<string, { ok: number; failed: number; exits: Set<number> }>();
  for (const run of toolRuns) {
    const name = run.tool_name ?? 'unknown tool';
    const entry = byTool.get(name) ?? { ok: 0, failed: 0, exits: new Set<number>() };
    if (run.error === undefined) {
      entry.ok += 1;
    } else {
      entry.failed += 1;
    }
    if (run.exit_code !== undefined && run.exit_code !== 0) {
      entry.exits.add(run.exit_code);
    }
    byTool.set(name, entry);
  }
  const tools = [...byTool.entries()].map(([name, entry]) => {
    const parts: string[] = [];
    if (entry.ok > 0) {
      parts.push(`${String(entry.ok)} ok`);
    }
    if (entry.failed > 0) {
      parts.push(`${String(entry.failed)} failed`);
    }
    const exits = [...entry.exits].sort((a, b) => a - b);
    if (exits.length > 0) {
      parts.push(`exit ${exits.map(String).join('/')}`);
    }
    return `${name} (${parts.join(', ')})`;
  });
  // The event fetch is capped, so the oldest turn can arrive without its start; its counts are
  // then a tail, not the turn, and the line must say so.
  const started = events.some(event => event.type === 'turn.created');
  const done = events.find(event => event.type === 'turn.done');
  const pending = done?.counts?.['pending_actions'] ?? 0;
  const ending =
    done === undefined
      ? 'still running or cut off'
      : done.outcome === 'done' && pending > 0
        ? `paused waiting on ${plural(pending, 'action')} from the user`
        : done.outcome === 'done'
          ? 'finished'
          : `ended ${done.outcome ?? 'unknown'}`;
  const elapsed = done?.at_ms;
  const errorNotes = reduced.errors
    .filter(error => error.event_type !== 'tool.response' && error.event_type !== 'tool.response.v2')
    .map(error =>
      error.code !== null && error.event_type === 'turn.done' ? `${error.message} (${error.code})` : error.message,
    );
  const compactionNotes = events
    .filter(event => event.type === 'agent.context.compaction')
    .map(event => {
      const before = event.counts?.['tokens_before'];
      const after = event.counts?.['tokens_after'];
      const modeNote = event.mode !== undefined ? ` (${event.mode} mode)` : '';
      if (event.outcome === 'applied' && before !== undefined && after !== undefined) {
        return `Context compacted from ${String(before)} to ${String(after)} tokens${modeNote}.`;
      }
      return `Context compaction ${event.outcome ?? 'attempted'}${modeNote}.`;
    });
  return [
    started
      ? `Turn ${String(index + 1)}: user wrote ${plural(userChars, 'char')}.`
      : `Turn ${String(index + 1)} (partial, its earliest events were not fetched): counts below cover only the fetched tail.`,
    `${plural(modelSteps.length, 'model step')}, ${plural(assistantChars, 'char')} of assistant text.`,
    tools.length > 0 ? `Tools: ${tools.join('; ')}.` : 'No tools ran.',
    `Turn ${ending}${elapsed !== undefined ? ` after ${String(Math.round(elapsed / 1000))} s` : ''}.`,
    ...compactionNotes,
    ...errorNotes,
  ].join(' ');
}

export interface BuildBugReportBundleInput {
  build: BuildIdentity;
  session: {
    id: string;
    agentName: string | null;
    model: string | null;
    createdAt: string;
    connectors: string[];
    skills: string[];
    sandboxEnabled: boolean;
  };
  /** The reporter's own typed text; included verbatim (not subject to redaction). */
  description: string | undefined;
  /** Session events as returned by the store, newest first; per-item shape is not assumed. */
  events: readonly { turn_id: string; event: unknown }[];
  configFlags: BugReportConfigFlags;
  /** Override for deterministic tests; defaults to `new Date().toISOString()`. */
  generatedAt?: string;
  /**
   * The reporter's explicit opt-in to carry the chat transcript. Off by default: this is the one
   * place message text is read for its value, and only because the reporter asked for it.
   */
  includeChat?: boolean;
}

/** Longest message text carried; the rest of a longer message is cut and the message flagged. */
export const MAX_CHAT_MESSAGE_CHARS = 4000;
/** Most transcript text carried in one bundle; the oldest messages past it are left out and counted. */
export const MAX_CHAT_TOTAL_CHARS = 60_000;

/**
 * Message text as a single string: a plain string, or the text and refusal parts of a content
 * array joined. A refusal is what the assistant said in place of an answer, so it is part of the
 * conversation the reporter is describing.
 */
function messageText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map(part => {
      if (!isRecord(part)) {
        return '';
      }
      if (part['type'] === 'text') {
        return asString(part['text']) ?? '';
      }
      if (part['type'] === 'refusal') {
        return asString(part['refusal']) ?? '';
      }
      return '';
    })
    .filter(text => text !== '')
    .join('\n');
}

/** The root agent's thread id; sub-agent messages are not part of the chat the user saw. */
const ROOT_THREAD_ID = 'main';

function isRootThread(event: Record<string, unknown>): boolean {
  const threadId = field(event, 'thread_id');
  return threadId === undefined || threadId === ROOT_THREAD_ID;
}

function boundedMessage(message: BugReportChatMessage): BugReportChatMessage {
  if (message.text.length <= MAX_CHAT_MESSAGE_CHARS) {
    return message;
  }
  return { ...message, text: message.text.slice(0, MAX_CHAT_MESSAGE_CHARS), truncated: true };
}

/** The transcript, plus how many of its oldest messages the total limit left out. */
export interface ChatTranscript {
  messages: BugReportChatMessage[];
  omittedMessages: number;
}

/**
 * The chat transcript: user messages from each turn's input and assistant messages from
 * `model.message`, oldest first. Nothing else: tool calls, tool results, memory blocks, learned
 * profile text, and client tool responses are left out even when the reporter opts in.
 */
export function extractChatTranscript(
  turns: readonly { turnId: string; events: readonly unknown[] }[],
): ChatTranscript {
  const messages: BugReportChatMessage[] = [];
  for (const turn of turns) {
    for (const raw of turn.events) {
      const event = isRecord(raw) ? raw : {};
      const type = asString(field(event, 'type'));
      if (type === 'turn.created') {
        for (const rawInputItem of asArray(field(event, 'input')) ?? []) {
          const inputItem = asRecord(rawInputItem);
          if (inputItem !== undefined && asString(field(inputItem, 'type')) === 'user.message') {
            const text = messageText(field(inputItem, 'content'));
            if (text !== '') {
              messages.push({ turn_id: turn.turnId, role: 'user', text });
            }
          }
        }
      } else if (type === 'model.message' && isRootThread(event)) {
        const text = messageText(field(event, 'content'));
        if (text !== '') {
          messages.push({ turn_id: turn.turnId, role: 'assistant', text });
        }
      }
    }
  }
  return boundTranscript(messages.map(boundedMessage));
}

/** Keeps the newest messages that fit the total limit: the bug is usually in the recent turns. */
function boundTranscript(messages: readonly BugReportChatMessage[]): ChatTranscript {
  let total = 0;
  let keptFrom = messages.length;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const next = total + (messages[index]?.text.length ?? 0);
    if (next > MAX_CHAT_TOTAL_CHARS) {
      break;
    }
    total = next;
    keptFrom = index;
  }
  return { messages: messages.slice(keptFrom), omittedMessages: keptFrom };
}

function chatNotes(transcript: ChatTranscript): string {
  const base =
    "Included at the reporter's request: the user and assistant message text of this chat, verbatim, and the " +
    "model's one-line intent for each tool step in the trace. Tool arguments and results, memory-recall content, " +
    'learned-profile text, sub-agent messages, and client tool responses are still left out.';
  const cut = transcript.messages.some(message => message.truncated === true)
    ? ` Messages longer than ${String(MAX_CHAT_MESSAGE_CHARS)} characters were cut and are marked truncated.`
    : '';
  const omitted =
    transcript.omittedMessages > 0
      ? ` The oldest ${String(transcript.omittedMessages)} message${transcript.omittedMessages === 1 ? '' : 's'} ` +
        `were left out to keep the transcript under ${String(MAX_CHAT_TOTAL_CHARS)} characters.`
      : '';
  return base + cut + omitted;
}

function chatSection(turnOrder: readonly string[], byTurn: ReadonlyMap<string, unknown[]>): BugReportChat {
  const transcript = extractChatTranscript(turnOrder.map(turnId => ({ turnId, events: byTurn.get(turnId) ?? [] })));
  return {
    messages: transcript.messages,
    notes: chatNotes(transcript),
    ...(transcript.omittedMessages > 0 ? { omitted_messages: transcript.omittedMessages } : {}),
  };
}

/** Fixed manifest of what this redactor strips — see the module doc for the read/never-read guarantee. */
const REDACTION_NOTES: BugReportBundle['redaction'] = {
  stripped_fields: [
    'model.message.content (assistant message text)',
    'turn.created.input[].content (user message / client tool-result text)',
    'tool_call.function.arguments (tool-call arguments; only `intent` is kept, and only when the chat is included)',
    'tool.execution_started.command_execution (command, cwd)',
    'tool.response(.v2).content (tool result payload)',
    'tool.response(.v2).remediation.message (free-text remediation detail)',
    'turn.done.state.message (turn error text)',
    'aman.memory.recall.injected_block',
    'aman.memory.recall.stats.reason (recall failure detail)',
    'aman.profile.learned.previous / .current',
    'agent.context.compaction.<summary text> (the persisted summary itself; only mode, token counts, ' +
      'summary length, and outcome are kept)',
    'thread.created.title, thread.done.state.error (subagent titles and thread error text)',
    'mcp.auth_required.mcp_servers[].auth_url',
  ],
  notes:
    'Only event structure is kept: types, tool names/effects/outcomes, durations, timing offsets, exit codes, ' +
    'counts, bounded host-owned reason codes, and fixed host-authored error messages derived from those codes. ' +
    'Raw error/remediation text, ' +
    'message text, memory-recall content, learned-profile text, tool arguments/results, and any credential, ' +
    'token, or auth-header value are never read into the bundle.',
};

/**
 * Input for the app-level bug-report bundle. Nothing session-bound: build identity, the
 * reporter's own text, and non-secret config flags.
 */
export interface BuildAppBugReportBundleInput {
  build: BuildIdentity;
  /** The reporter's own typed text; included verbatim (not subject to redaction). */
  description: string | undefined;
  configFlags: BugReportConfigFlags;
  /** Override for deterministic tests; defaults to `new Date().toISOString()`. */
  generatedAt?: string;
}

/** Manifest of what the app-level bundle excludes — there is nothing session-bound to redact. */
const APP_REDACTION_NOTES: AppBugReportBundle['redaction'] = {
  stripped_fields: [
    'session.id and all session metadata (no session is attached)',
    'session event trace (no events are collected)',
    'chat transcript (no messages are collected)',
  ],
  notes:
    "This app-level report collects nothing session-bound: build identity, the reporter's own " +
    'description, non-secret config flags, and this note. Message text, tool arguments/results, ' +
    'memory content, learned-profile text, and any credential, token, or auth-header value are ' +
    'never read into the bundle.',
};

/** Assembles the redacted app-level bug-report bundle. Pure and synchronous — no I/O. */
export function buildAppBugReportBundle(input: BuildAppBugReportBundleInput): AppBugReportBundle {
  return {
    schema_version: BUG_REPORT_SCHEMA_VERSION,
    generated_at: input.generatedAt ?? new Date().toISOString(),
    build: input.build,
    user_description: input.description ?? '',
    config_flags: input.configFlags,
    redaction: APP_REDACTION_NOTES,
  };
}

/** Assembles the redacted bug-report bundle for one session. Pure and synchronous — no I/O. */
export function buildBugReportBundle(input: BuildBugReportBundleInput): BugReportBundle {
  // The store lists newest first; walk oldest-first so tool-call start/finish pairs and
  // turn-created/turn-done ordering read naturally within each turn.
  const chronological = [...input.events].reverse();

  const turnOrder: string[] = [];
  const byTurn = new Map<string, unknown[]>();
  for (const item of chronological) {
    if (!byTurn.has(item.turn_id)) {
      byTurn.set(item.turn_id, []);
      turnOrder.push(item.turn_id);
    }
    byTurn.get(item.turn_id)?.push(item.event);
  }

  const trace: BugReportTurnTrace[] = [];
  const allErrors: BugReportError[] = [];
  const summary: string[] = [];
  const includeIntent = input.includeChat === true;
  for (const [index, turnId] of turnOrder.entries()) {
    const reduced = reduceTurnEvents(turnId, byTurn.get(turnId) ?? [], { includeIntent });
    trace.push({ turn_id: turnId, events: reduced.events });
    allErrors.push(...reduced.errors);
    summary.push(summarizeTurn(index, reduced));
  }
  const chat = input.includeChat === true ? chatSection(turnOrder, byTurn) : undefined;

  return {
    schema_version: BUG_REPORT_SCHEMA_VERSION,
    generated_at: input.generatedAt ?? new Date().toISOString(),
    build: input.build,
    session: {
      id: input.session.id,
      agent_name: input.session.agentName,
      model: input.session.model,
      created_at: input.session.createdAt,
      connectors: input.session.connectors,
      skills: input.session.skills,
      sandbox_enabled: input.session.sandboxEnabled,
    },
    user_description: input.description ?? '',
    summary,
    trace,
    recent_errors: allErrors.slice(-MAX_RECENT_ERRORS).reverse(),
    config_flags: input.configFlags,
    redaction: REDACTION_NOTES,
    ...(chat === undefined ? {} : { chat }),
  };
}

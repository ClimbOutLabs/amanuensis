import { z } from 'zod';

/**
 * Host-owned task state: the structural fix for "the conversation is used as
 * working memory, then lossy-compacted mid-task".
 *
 * A long research turn accumulates findings only as transcript messages. When
 * context compaction fires, the compaction summary keeps the gist but drops
 * the exact facts, so the model re-researches what it already found and the
 * final answer is composed from whatever happened to survive. Task state fixes
 * this at the root:
 *
 * - Findings are written through the host-owned `record_finding` tool into a
 *   structured store that lives in the AgentThread, NOT in `this.context`.
 * - Before every model call, the host re-injects the full state as a fresh
 *   `<task_state>` block. Compaction only ever touches transcript messages,
 *   so the block is immune to it by construction.
 * - A host-owned per-turn tool-call budget (`AgentDefinition.toolCallBudget`)
 *   bounds the research phase. When it is exhausted the host moves the task
 *   into the `final_answer` phase: the configured budgeted research tools are
 *   withheld from the model request (only `record_finding` stays, so the model
 *   can bank its last facts), forcing the final-answer pass. Control,
 *   approval, host, and unrelated tools stay available. The model never
 *   decides whether to keep researching.
 *
 * The feature is opt-in: it is fully inert unless the agent definition sets
 * `toolCallBudget` (which requires `budgetedTools`).
 */

/** Canonical (original) tool name of the host-owned finding recorder. */
export const TASK_STATE_TOOL_NAME = 'record_finding';

/** Upper bound on findings banked per user request. The tool rejects beyond this. */
export const MAX_TASK_FINDINGS = 100;

/**
 * Task phase. `research`: the model may use budgeted research tools.
 * `final_answer`: the budget is spent; the host withholds research tools and
 * the model must compose its answer from the banked findings. The transition
 * is host-owned (see `syncTaskPhase`), never model-chosen.
 */
export const TaskPhaseSchema = z.enum(['research', 'final_answer']);
export type TaskPhase = z.infer<typeof TaskPhaseSchema>;

export const TaskFindingSchema = z.object({
  /** Short beat or area label, e.g. "Spain/Madrid". */
  label: z.string().min(1).max(120),
  /** The fact itself, in one or two sentences. */
  headline: z
    .string()
    .min(1)
    .refine(v => v.length <= 300, 'must be at most 300 characters'),
  /** Why this fact matters for the user's request. */
  why_it_matters: z
    .string()
    .min(1)
    .refine(v => v.length <= 500, 'must be at most 500 characters'),
  /** Source URL. */
  url: z
    .string()
    .min(1)
    .refine(v => v.length <= 2000, 'must be at most 2000 characters'),
});
export type TaskFinding = z.infer<typeof TaskFindingSchema>;

export const TaskStateSchema = z.object({
  findings: z.array(TaskFindingSchema),
  /** Budget-consuming tool calls executed so far this user request. */
  tool_calls_used: z.number().int().min(0),
  phase: TaskPhaseSchema,
});
export type TaskState = z.infer<typeof TaskStateSchema>;
/** Persisted form; identical shape, validated on load. */
export type TaskStateSnapshot = z.infer<typeof TaskStateSchema>;

/**
 * Lenient hydration shape: `phase` may be absent in snapshots written before
 * phases existed. Corrupt findings or counters still degrade to an empty
 * state via the strict schema fallback in `taskStateFromSnapshot`.
 */
const TaskStateHydrationSchema = z.object({
  findings: z.array(TaskFindingSchema),
  tool_calls_used: z.number().int().min(0),
  phase: TaskPhaseSchema.optional(),
});

/** Fresh, empty task state for a new user request. */
export function createTaskState(): TaskState {
  return { findings: [], tool_calls_used: 0, phase: 'research' };
}

/** Independent copy; mutations of the copy never alias the original's findings. */
export function cloneTaskState(state: TaskState): TaskState {
  return {
    findings: state.findings.map(finding => ({ ...finding })),
    tool_calls_used: state.tool_calls_used,
    phase: state.phase,
  };
}

/**
 * Hydrate task state from a snapshot (approval/tool-response continuations
 * rebuild the thread from the preceding snapshot). Accepts unknown input:
 * corrupt or absent input degrades to an empty state, never throws. Snapshots
 * written before phases existed hydrate into the research phase; the caller
 * re-syncs the phase against the budget (see `syncTaskPhase`).
 */
export function taskStateFromSnapshot(snapshot: unknown): TaskState {
  if (snapshot === undefined || snapshot === null) {
    return createTaskState();
  }
  const parsed = TaskStateHydrationSchema.safeParse(snapshot);
  if (!parsed.success) {
    return createTaskState();
  }
  return {
    findings: parsed.data.findings,
    tool_calls_used: parsed.data.tool_calls_used,
    phase: parsed.data.phase ?? 'research',
  };
}

/** Serialize task state for AgentThreadSnapshot. Defensive copy. */
export function toTaskStateSnapshot(state: TaskState): TaskStateSnapshot {
  return cloneTaskState(state);
}

/** The task-state feature is active only when the agent opts into a tool-call budget. */
export function isTaskStateActive(budget: number | undefined): boolean {
  return budget !== undefined;
}

/**
 * Whether a tool (by canonical original name) is charged against the
 * research budget and withheld once it is spent. Patterns are the agent's
 * configured `budgeted_tools`; `*` matches any run of characters, so
 * `tavily*` budgets every Tavily tool. Matching is case-sensitive against
 * the exact tool name. The host-owned `record_finding` tool is always
 * exempt — it can never be budgeted, even by `*`.
 */
export function matchesBudgetedTool(originalToolName: string, budgetedTools: readonly string[]): boolean {
  if (originalToolName === TASK_STATE_TOOL_NAME) {
    return false;
  }
  for (const pattern of budgetedTools) {
    if (pattern === '*') {
      return true;
    }
    if (!pattern.includes('*')) {
      if (pattern === originalToolName) {
        return true;
      }
      continue;
    }
    // Convert the glob to a regex: escape everything, then turn \* into .*.
    const regex = new RegExp(`^${pattern.split('*').map(escapeRegExp).join('.*')}$`);
    if (regex.test(originalToolName)) {
      return true;
    }
  }
  return false;
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True once the turn's research budget is spent; the host must then withhold tools. */
export function isToolBudgetExhausted(state: TaskState, budget: number | undefined): boolean {
  if (budget === undefined) {
    return false;
  }
  return state.tool_calls_used >= budget;
}

/**
 * Host-owned phase transition. Moves `research` to `final_answer` once the
 * budget is exhausted; idempotent and never transitions back. The caller is
 * responsible for persisting the state afterwards (the transition sites are
 * always followed by a context append that carries the new snapshot).
 */
export function syncTaskPhase(state: TaskState, budget: number | undefined): void {
  if (state.phase === 'research' && isToolBudgetExhausted(state, budget)) {
    state.phase = 'final_answer';
  }
}

/**
 * Record one finding in the turn's scratchpad. Returns whether the finding
 * was banked; false when the per-request cap is reached.
 */
export function recordTaskFinding(state: TaskState, finding: TaskFinding): { recorded: boolean } {
  if (state.findings.length >= MAX_TASK_FINDINGS) {
    return { recorded: false };
  }
  state.findings.push({ ...finding });
  return { recorded: true };
}

/**
 * Charge executed tool calls against the budget. Only calls to configured
 * budgeted tools consume budget — control, approval, host, and unrelated
 * tools are free. The `record_finding` tool itself is exempt: it is local
 * bookkeeping with no external cost, and charging it would punish the model
 * for using the scratchpad (see `matchesBudgetedTool`). The caller passes
 * only calls that actually dispatched (memoized replays and
 * never-ran/denied/policy-blocked calls cost nothing and must be filtered
 * before this call).
 */
export function noteExecutedToolCalls(
  state: TaskState,
  originalToolNames: readonly string[],
  budgetedTools: readonly string[],
): void {
  for (const name of originalToolNames) {
    if (!matchesBudgetedTool(name, budgetedTools)) {
      continue;
    }
    state.tool_calls_used += 1;
  }
}

/** One tool call awaiting a host-owned budget admission decision. */
export interface BudgetAdmissionCall {
  id: string;
  originalToolName: string;
}

/**
 * Host-owned pre-dispatch admission: decide exactly which of the model's
 * emitted calls may dispatch when the remaining budget cannot cover the whole
 * batch. Only configured budgeted tools are subject to admission — every
 * other tool (control, approval, host, unrelated) is always admitted.
 * `record_finding` is always admitted (budget-exempt bookkeeping, see
 * `matchesBudgetedTool`); budgeted calls are admitted in emission order
 * until the remaining budget is spent. In the `final_answer` phase only
 * non-budgeted tools (plus `record_finding`) are admitted — the model must
 * compose its answer instead of researching further.
 * Returns the admitted call ids. Never mutates the state.
 */
export function admitToolCallsForBudget(input: {
  state: TaskState;
  budget: number | undefined;
  budgetedTools: readonly string[];
  calls: readonly BudgetAdmissionCall[];
}): ReadonlySet<string> {
  const { state, budget, budgetedTools, calls } = input;
  const admitted = new Set<string>();
  if (budget === undefined) {
    for (const call of calls) {
      admitted.add(call.id);
    }
    return admitted;
  }
  let remaining = budget - state.tool_calls_used;
  const finalAnswerPhase = state.phase === 'final_answer';
  for (const call of calls) {
    if (!matchesBudgetedTool(call.originalToolName, budgetedTools)) {
      admitted.add(call.id);
      continue;
    }
    if (finalAnswerPhase || remaining <= 0) {
      continue;
    }
    admitted.add(call.id);
    remaining -= 1;
  }
  return admitted;
}

function renderFinding(finding: TaskFinding, index: number): string {
  return `${String(index + 1)}. [${finding.label}] ${finding.headline} — ${finding.why_it_matters} — ${finding.url}`;
}

/**
 * Render the per-step `<task_state>` block. Returns null when the feature is
 * off (no budget configured); otherwise always returns a block, even with
 * zero findings, so the model sees its budget, its phase, and the recording
 * instruction.
 *
 * The caller injects this as a fresh system message on every model call,
 * AFTER transcript assembly — never persisted into context, never compacted.
 */
export function renderTaskStateBlock(input: { state: TaskState; budget: number | undefined }): string | null {
  const { state, budget } = input;
  if (budget === undefined) {
    return null;
  }
  const lines: string[] = ['<task_state>'];
  if (state.phase === 'final_answer') {
    lines.push(
      `Phase: final_answer. Tool-call budget exhausted (${String(state.tool_calls_used)} of ${String(budget)} used). ` +
        'Budgeted research tools are no longer available. Write your final answer now, composed from the findings below. ' +
        'You may still use record_finding to bank any last facts before answering.',
    );
  } else {
    lines.push(
      `Phase: research. Tool-call budget: ${String(state.tool_calls_used)} of ${String(budget)} used.`,
      'Record every useful result with the record_finding tool as you go. This block is your durable scratchpad: ' +
        'it is re-injected fresh before every model call and is never affected by context compaction. ' +
        'When the budget runs out you will enter the final-answer phase and must compose your answer from these findings.',
    );
  }
  if (state.findings.length === 0) {
    lines.push('Findings so far: none yet.');
  } else {
    lines.push(`Findings (${String(state.findings.length)}):`);
    for (const [index, finding] of state.findings.entries()) {
      lines.push(renderFinding(finding, index));
    }
  }
  lines.push('</task_state>');
  return lines.join('\n');
}

import { SUPPORTED_REASONING_EFFORTS } from './VercelAILLM';

/**
 * What a model call is for, decided by the agent loop before each request. Only the loop knows
 * this: a first step answers the user's message, a continuation reads tool results, a final-answer
 * step writes the reply with no tools left to call, and a sub-agent step serves its parent.
 */
export const REASONING_STEP_KINDS = ['first', 'continuation', 'final_answer', 'sub_agent'] as const;
export type ReasoningStepKind = (typeof REASONING_STEP_KINDS)[number];

/**
 * `automatic` picks an effort per step kind. `fixed` sends the persona's stored effort on every
 * step, which is what every step did before per-step effort existed. Absent means `automatic`.
 */
export const REASONING_EFFORT_MODES = ['automatic', 'fixed'] as const;
export type ReasoningEffortMode = (typeof REASONING_EFFORT_MODES)[number];

/** Target level per step kind, mapped to the nearest level the model actually supports. */
export const STEP_REASONING_LEVEL = {
  first: 'high',
  continuation: 'low',
  final_answer: 'medium',
  sub_agent: 'low',
} as const satisfies Record<ReasoningStepKind, string>;

/**
 * Visible-output cap for final-answer steps that offer no tools, so the output is prose alone and a
 * short reply is all the step needs. Steps that may emit a tool call are never capped: the provider
 * counts a call's arguments against the same limit, so a cap would cut a large write mid-call.
 */
export const FINAL_ANSWER_OUTPUT_TOKENS = 2_048;

/**
 * Extra room for reasoning when a capped step has an effort set. Providers count reasoning against
 * the same max-output limit, so without it the cap would also cut the reasoning short.
 */
export const CAPPED_STEP_REASONING_ALLOWANCE_TOKENS = 4_096;

/** Rank of each known effort, lowest first, so "nearest" means the smallest step between levels. */
const EFFORT_RANK: ReadonlyMap<string, number> = new Map(
  SUPPORTED_REASONING_EFFORTS.map((effort, rank) => [effort, rank]),
);

/**
 * The supported effort closest to `target`. Ties go to the lower effort, which costs fewer tokens.
 * Efforts the harness does not know are ignored, and undefined means none of the listed efforts is known.
 */
export function nearestSupportedEffort({
  target,
  supported,
}: {
  target: string;
  supported: readonly string[];
}): string | undefined {
  const targetRank = EFFORT_RANK.get(target);
  if (targetRank === undefined) {
    return undefined;
  }
  let best: { effort: string; distance: number; rank: number } | undefined;
  for (const effort of supported) {
    const rank = EFFORT_RANK.get(effort);
    if (rank === undefined) {
      continue;
    }
    const distance = Math.abs(rank - targetRank);
    if (best === undefined || distance < best.distance || (distance === best.distance && rank < best.rank)) {
      best = { effort, distance, rank };
    }
  }
  return best?.effort;
}

/**
 * The effort to send for one request, or undefined when no effort parameter should be sent. A model
 * that advertises no efforts never gets one, whatever the persona stored.
 */
export function resolveStepReasoningEffort({
  stepKind,
  mode,
  storedEffort,
  supported,
}: {
  stepKind: ReasoningStepKind;
  mode: ReasoningEffortMode;
  storedEffort: string | undefined;
  supported: readonly string[] | undefined;
}): string | undefined {
  if (supported === undefined || supported.length === 0) {
    return undefined;
  }
  const target = mode === 'fixed' ? storedEffort : STEP_REASONING_LEVEL[stepKind];
  if (target === undefined) {
    return undefined;
  }
  return nearestSupportedEffort({ target, supported });
}

/**
 * The max-output cap for a request. Only a final-answer step that offers no tools is capped; every
 * other step keeps the configured limit, and an unset limit stays unset for it.
 */
export function stepMaxOutputTokens({
  stepKind,
  offersTools,
  configured,
  reasoningEffort,
}: {
  stepKind: ReasoningStepKind;
  offersTools: boolean;
  configured: number | undefined;
  reasoningEffort: string | undefined;
}): number | undefined {
  if (stepKind !== 'final_answer' || offersTools) {
    return configured;
  }
  const reasoningAllowance =
    reasoningEffort !== undefined && reasoningEffort !== 'none' ? CAPPED_STEP_REASONING_ALLOWANCE_TOKENS : 0;
  const cap = FINAL_ANSWER_OUTPUT_TOKENS + reasoningAllowance;
  return configured === undefined ? cap : Math.min(configured, cap);
}

/** Reads the persisted mode key; anything other than `fixed` (including absent) is `automatic`. */
export function readReasoningEffortMode(params: Record<string, unknown> | undefined): ReasoningEffortMode {
  return Reflect.get(params ?? {}, 'reasoning_effort_mode') === 'fixed' ? 'fixed' : 'automatic';
}

/** The persona's stored effort, or undefined when it is absent or not a string. */
export function readStoredReasoningEffort(params: Record<string, unknown> | undefined): string | undefined {
  const stored = Reflect.get(params ?? {}, 'reasoning_effort');
  return typeof stored === 'string' ? stored : undefined;
}

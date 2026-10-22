import type { Model, ModelParams, ModelSelection } from '../../server/types.js';

type ReasoningEfforts = ModelSelection['properties']['reasoningEfforts'];

export function hasReasoningEfforts(efforts: ReasoningEfforts): efforts is string[] {
  return Array.isArray(efforts) && efforts.length > 0;
}

/**
 * Keep current if still listed for this model; otherwise the provider default:
 * "medium" when the model offers it, else the lowest non-"none" effort
 * (catalog lists are ordered ascending), else "none" if that is the only entry.
 * Undefined when the model has no efforts at all.
 */
export function resolveReasoningEffort(efforts: ReasoningEfforts, current: string | undefined): string | undefined {
  if (!hasReasoningEfforts(efforts)) return undefined;
  if (current && efforts.includes(current)) return current;
  if (efforts.includes('medium')) return 'medium';
  return efforts.find(effort => effort !== 'none') ?? efforts[0];
}

/**
 * Draft model patch: preserve other params, set or clear `reasoningEffort`.
 *
 * When clearing, set `reasoningEffort: undefined` (do not omit the key).
 * `mergeAgentSpec` in `@truefoundry/assistant-ui-runtime` shallow-merges
 * `model.params`, so omitting the key leaves a sticky prior effort and the
 * server then 422s on models that do not advertise `reasoning_efforts`.
 */
export function modelPatchWithReasoningEffort(
  name: string,
  existingParams: ModelParams | undefined,
  efforts: ReasoningEfforts,
): Model {
  const nextEffort = resolveReasoningEffort(efforts, existingParams?.reasoningEffort);
  if (nextEffort === undefined) {
    if (!existingParams) return { name };
    const { reasoningEffort: _cleared, ...rest } = existingParams;
    return { name, params: { ...rest, reasoningEffort: undefined } };
  }
  return {
    name,
    params: { ...existingParams, reasoningEffort: nextEffort },
  };
}

/** How the agent picks reasoning effort: per step, or the stored effort on every step. */
export type ThinkingMode = 'automatic' | 'fixed';

/** Absent means automatic, matching the server's reading of a stored mode. */
export function readThinkingMode(params: ModelParams | undefined): ThinkingMode {
  const mode: unknown = params?.reasoningEffortMode;
  return mode === 'fixed' ? 'fixed' : 'automatic';
}

/** Model params with the thinking mode set; "always high" also stores the nearest supported high effort. */
export function paramsWithThinkingMode(
  existingParams: ModelParams | undefined,
  mode: ThinkingMode,
  efforts: ReasoningEfforts,
): ModelParams {
  if (mode === 'automatic') {
    return { ...existingParams, reasoningEffortMode: 'automatic' };
  }
  return {
    ...existingParams,
    reasoningEffortMode: 'fixed',
    reasoningEffort: resolveReasoningEffort(efforts, 'high'),
  };
}

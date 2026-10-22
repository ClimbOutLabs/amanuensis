/**
 * How one reply stays within a fixed number of steps, and how each tool result is sorted for that.
 *
 * A declined or unavailable tool is removed for the rest of the reply, since asking again cannot
 * change the answer. A retryable error gets exactly one more try. A reply past its step budget is
 * answered with no tools at all. The turn ledger holds the counts; this module holds the rules.
 */
import { z } from 'zod';
import type { ToolResultDisposition } from '../events/schema';

export const ToolResultKindSchema = z.enum(['ok', 'refused', 'unavailable', 'error_retryable', 'error_final']);
export type ToolResultKind = z.infer<typeof ToolResultKindSchema>;

/** Model calls one reply may make: the main thread, and each sub-agent. */
export interface ReplyStepBudget {
  main: number;
  sub: number;
}

export const DEFAULT_REPLY_STEP_BUDGET: ReplyStepBudget = { main: 8, sub: 4 };

/** Calls to removed tools in a row before the reply's answer is forced. */
export const REMOVED_TOOL_STREAK_STOP_AT = 2;

export const STEP_BUDGET_SPENT_MESSAGE = 'The step budget for this reply is spent. Answer with what you have.';

export const REMOVED_TOOL_STREAK_MESSAGE =
  'Tools that were declined or are not available keep being called. Answer with what you have.';

/** Result text for a call to a tool removed from this reply. Not run. */
export const REMOVED_TOOL_RESULT =
  'This tool was removed from this reply because it was declined or is not available here. Do not call it again.';

export function stepBudgetFor({ isSubAgent, budget }: { isSubAgent: boolean; budget: ReplyStepBudget }): number {
  return isSubAgent ? budget.sub : budget.main;
}

/** Tool names are snake_case; the person and the model read them as plain words. */
function toolActionName(toolName: string): string {
  return toolName.replace(/_/g, ' ');
}

export function removedToolMessage({
  toolName,
  reason,
}: {
  toolName: string;
  reason: 'declined' | 'unavailable';
}): string {
  const action = toolActionName(toolName);
  const cause = reason === 'declined' ? `The person declined ${action}` : `${action} is not available here`;
  return `${cause}. Do not try it again. Tell them what you did and did not do.`;
}

/**
 * The kind of one finished tool call. `disposition` is how the call ended; `ruleRefused` says a
 * tool policy rule refused it, as opposed to a step that must be fixed and tried again. A call
 * whose tool was already removed from the reply is always final, since it was rejected unrun.
 */
export function toolResultKind({
  disposition,
  failure,
  unavailable,
  removed,
  ruleRefused,
}: {
  disposition: ToolResultDisposition;
  failure: boolean;
  unavailable: boolean;
  removed: boolean;
  ruleRefused: boolean;
}): ToolResultKind {
  if (unavailable) {
    return 'unavailable';
  }
  if (removed) {
    return 'error_final';
  }
  switch (disposition) {
    case 'executed_ok':
      return failure ? 'error_retryable' : 'ok';
    case 'denied':
      return 'refused';
    case 'policy_blocked':
      return ruleRefused ? 'refused' : 'error_retryable';
    case 'executed_nonzero':
    case 'never_ran':
      return 'error_retryable';
    case 'outcome_unknown':
      return 'error_final';
  }
}

/** Whether an identical call may run once more after its last run returned a retryable error. */
export function retryIsDue({ lastKind, retried }: { lastKind: ToolResultKind | null; retried: boolean }): boolean {
  return lastKind === 'error_retryable' && !retried;
}

/**
 * The record for a call after it runs again. Its second retryable error is final, so one call
 * is never tried more than twice in a reply.
 */
export function settleRetry({
  previousKind,
  previousRetried,
  kind,
}: {
  previousKind: ToolResultKind | null;
  previousRetried: boolean;
  kind: ToolResultKind;
}): { kind: ToolResultKind; retried: boolean } {
  const retried = previousRetried || retryIsDue({ lastKind: previousKind, retried: previousRetried });
  return { kind: kind === 'error_retryable' && retried ? 'error_final' : kind, retried };
}

/** Why a reply that ends on this kind of result is not finished, in plain words. Null when it finished. */
export function unfinishedReasonFor(kind: ToolResultKind): string | null {
  switch (kind) {
    case 'ok':
      return null;
    case 'refused':
      return 'a step was declined';
    case 'unavailable':
      return 'a tool is not available here';
    case 'error_retryable':
    case 'error_final':
      return 'a step failed';
  }
}

export function unfinishedNotice(reason: string): string {
  return `Not finished: ${reason}.`;
}

/**
 * How one reply stays within a fixed number of steps, and how each tool result is sorted for that.
 *
 * A tool the person declined, or that is not available, is removed for the rest of the reply, since
 * asking again cannot change the answer. A rule that blocks one call blocks that call only. A
 * retryable error gets exactly one more try. A reply past its step budget is answered with no tools
 * at all. The turn ledger holds the counts and the reason a reply did not finish; this module holds
 * the rules and the words.
 */
import { z } from 'zod';
import type { ToolResultDisposition } from '../events/schema';

export const ToolResultKindSchema = z.enum([
  'ok',
  'declined',
  'blocked',
  'unavailable',
  'error_retryable',
  'error_final',
]);
export type ToolResultKind = z.infer<typeof ToolResultKindSchema>;

/** Why a reply did not finish. The kind is saved; the words are built when the reply is written. */
export const UnfinishedKindSchema = z.enum(['declined', 'blocked', 'unavailable', 'failed', 'budget']);
export type UnfinishedKind = z.infer<typeof UnfinishedKindSchema>;

/** Model calls one reply may make: the main thread, and each sub-agent. */
export interface ReplyStepBudget {
  main: number;
  sub: number;
}

export const DEFAULT_REPLY_STEP_BUDGET: ReplyStepBudget = { main: 8, sub: 4 };

/** Calls to removed tools in a row before the reply's answer is forced. */
export const REMOVED_TOOL_STREAK_STOP_AT = 2;

/** Why a step is answered with no tools. */
export type ForcedAnswer = 'budget' | 'removed_streak';

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
 * The kind of one finished tool call. `disposition` is how the call ended. Only the person's own
 * answer is a decline; a rule that blocks a call is a block, which ends that call and nothing else.
 * A call whose tool was already removed from the reply is always final, since it was rejected unrun.
 */
export function toolResultKind({
  disposition,
  failure,
  unavailable,
  removed,
}: {
  disposition: ToolResultDisposition;
  failure: boolean;
  unavailable: boolean;
  removed: boolean;
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
      return 'declined';
    case 'policy_blocked':
      return 'blocked';
    case 'executed_nonzero':
    case 'never_ran':
      return 'error_retryable';
    case 'outcome_unknown':
      return 'error_final';
  }
}

/** Whether a tool's removal comes from the person's own answer or from the tool being unavailable. */
export function removesTool(kind: ToolResultKind): boolean {
  return kind === 'declined' || kind === 'unavailable';
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

/** Why a reply whose last action ended on this kind did not finish. Null when that action finished. */
export function unfinishedKindFor(kind: ToolResultKind): UnfinishedKind | null {
  switch (kind) {
    case 'ok':
      return null;
    case 'declined':
      return 'declined';
    case 'blocked':
      return 'blocked';
    case 'unavailable':
      return 'unavailable';
    case 'error_retryable':
    case 'error_final':
      return 'failed';
  }
}

/** A decline or an unavailable tool stays the reason the reply did not finish, until the reply ends. */
function staysForReply(kind: UnfinishedKind): boolean {
  return kind === 'declined' || kind === 'unavailable';
}

/** Records why a reply did not finish. The first reason stays, except that a decline or unavailable tool replaces it. */
export function recordUnfinished({
  current,
  kind,
}: {
  current: UnfinishedKind | undefined;
  kind: UnfinishedKind;
}): UnfinishedKind {
  return current === undefined || staysForReply(kind) ? kind : current;
}

/** A step that finished clears the reason, except a decline or unavailable tool, which still stands. */
export function clearUnfinished({ current }: { current: UnfinishedKind | undefined }): UnfinishedKind | undefined {
  return current !== undefined && staysForReply(current) ? current : undefined;
}

/** The one sentence the person reads when a reply did not finish: what stopped it, and what to do next. */
export function unfinishedNotice(kind: UnfinishedKind): string {
  switch (kind) {
    case 'declined':
      return 'You said no to one step, so Aman did not finish. Ask again if you want that step done.';
    case 'blocked':
      return 'Aman could not do one step because it is not allowed here. Tell Aman another way to do it, or ask for something else.';
    case 'unavailable':
      return 'Aman could not finish because a tool it needed is not available right now. Check that its app is connected, then ask again.';
    case 'failed':
      return 'Aman could not finish because a step failed. Reply "try again" to let it retry.';
    case 'budget':
      return 'Aman stopped after many steps without finishing. Reply "continue" to let it carry on.';
  }
}

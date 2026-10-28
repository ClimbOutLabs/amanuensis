/**
 * How one reply stays within a fixed number of steps, and how each tool result is sorted for that.
 *
 * A tool the person declined, or that is not available, is removed for the rest of the reply, since
 * asking again cannot change the answer. A card nobody answered in time is not a decline: it says it
 * expired. A rule that blocks one call blocks that call only. A
 * retryable error gets exactly one more try. A reply past its step budget is answered with no tools
 * at all. The turn ledger holds the counts and the reason a reply did not finish; this module holds
 * the rules and the words.
 */
import { z } from 'zod';
import type { ToolResultDisposition } from '../events/schema';
import { isSpaceWriteToolName } from '../spaces/toolContract';

export const ToolResultKindSchema = z.enum([
  'ok',
  'declined',
  'expired',
  'blocked',
  'unavailable',
  'error_retryable',
  'error_final',
]);
export type ToolResultKind = z.infer<typeof ToolResultKindSchema>;

/** Why a reply did not finish. The kind is saved; the words are built when the reply is written. */
export const UnfinishedKindSchema = z.enum(['declined', 'expired', 'blocked', 'unavailable', 'failed', 'budget']);
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

/** Steps one thread may get back in a reply for landing space writes. With the base budget this bounds a reply at 8 + 12 steps. */
export const MAX_PROGRESS_STEP_REFUNDS = 12;

export const STEP_BUDGET_SPENT_MESSAGE =
  'The step budget for this reply is spent. Answer with what you have, and say plainly that you stopped before finishing and that they can ask you to continue.';

/** Used when the budget runs out after space writes landed. */
export const STEP_BUDGET_SPENT_AFTER_SPACE_WRITE_MESSAGE =
  'The step budget for this reply is spent. Answer with what you have. Say which space you changed and what is still missing, and say plainly that you stopped before finishing and that they can ask you to continue.';

export const REMOVED_TOOL_STREAK_MESSAGE =
  'Tools that were declined or are not available keep being called. Answer with what you have.';

/** Result text for a call to a tool removed from this reply. Not run. */
export const REMOVED_TOOL_RESULT =
  'This tool was removed from this reply because it was declined or is not available here. Do not call it again.';

export function stepBudgetFor({ isSubAgent, budget }: { isSubAgent: boolean; budget: ReplyStepBudget }): number {
  return isSubAgent ? budget.sub : budget.main;
}

/**
 * Steps to hand back after one tool batch: one when a space write in it landed cleanly, so a build
 * done in parts is not cut off by its own progress. Refused or failed writes earn nothing, and the
 * total per thread never passes MAX_PROGRESS_STEP_REFUNDS.
 */
export function progressRefundFor({
  results,
  refundsSoFar,
}: {
  results: readonly { toolName: string; disposition: ToolResultDisposition; failure: boolean }[];
  refundsSoFar: number;
}): number {
  const landedWrite = results.some(
    result => isSpaceWriteToolName(result.toolName) && result.disposition === 'executed_ok' && !result.failure,
  );
  return landedWrite && refundsSoFar < MAX_PROGRESS_STEP_REFUNDS ? 1 : 0;
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
  if (reason === 'declined') {
    return `The person declined ${action}. Do not try it again or ask again. Say once, plainly, that it was skipped, and carry on with the rest.`;
  }
  return `${action} is not available here. Do not try it again. Tell them what you did and did not do.`;
}

/**
 * The kind of one finished tool call. `disposition` is how the call ended. Only the person's own
 * answer is a decline: a card the app closed unanswered (`expired`) is not, and a rule that blocks a
 * call is a block, which ends that call and nothing else. A call whose tool was already removed from
 * the reply is always final, since it was rejected unrun.
 */
export function toolResultKind({
  disposition,
  failure,
  unavailable,
  removed,
  expired,
}: {
  disposition: ToolResultDisposition;
  failure: boolean;
  unavailable: boolean;
  removed: boolean;
  expired: boolean;
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
      return expired ? 'expired' : 'declined';
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
    case 'expired':
      return 'expired';
    case 'blocked':
      return 'blocked';
    case 'unavailable':
      return 'unavailable';
    case 'error_retryable':
    case 'error_final':
      return 'failed';
  }
}

/** A decline, an expired card or an unavailable tool stays the reason the reply did not finish, until the reply ends. */
function staysForReply(kind: UnfinishedKind): boolean {
  return kind === 'declined' || kind === 'expired' || kind === 'unavailable';
}

/** Records why a reply did not finish. The first reason stays, except that a reason that stays for the reply replaces it. */
export function recordUnfinished({
  current,
  kind,
}: {
  current: UnfinishedKind | undefined;
  kind: UnfinishedKind;
}): UnfinishedKind {
  return current === undefined || staysForReply(kind) ? kind : current;
}

/** A step that finished clears the reason, except one that stays for the reply, which still stands. */
export function clearUnfinished({ current }: { current: UnfinishedKind | undefined }): UnfinishedKind | undefined {
  return current !== undefined && staysForReply(current) ? current : undefined;
}

/**
 * Lines older versions added after every unfinished reply. Saved chats still hold them, and a model that
 * reads one in its own earlier reply repeats it on replies it does not fit.
 */
const LEGACY_UNFINISHED_NOTICES = [
  'You said no to one step, so Aman did not finish. Ask again if you want that step done.',
  'Aman could not do one step because it is not allowed here. Tell Aman another way to do it, or ask for something else.',
  'Aman could not finish because a tool it needed is not available right now. Check that its app is connected, then ask again.',
  'Aman could not finish because a step failed. Reply "try again" to let it retry.',
  'Aman stopped after many steps without finishing. Reply "continue" to let it carry on.',
];

/** An earlier reply's text as the model reads it: without a line an older version added for the person. */
export function withoutUnfinishedNotices(text: string): string {
  let result = text;
  for (const notice of LEGACY_UNFINISHED_NOTICES) {
    result = result.split(`\n\n${notice}`).join('').split(notice).join('');
  }
  return result;
}

/**
 * The line the person reads when a reply stopped with no words of its own. A reply with text says why in
 * the model's own words, since the model is told the true reason; this only keeps a reply from being empty.
 */
export function unfinishedNotice(kind: UnfinishedKind): string {
  switch (kind) {
    case 'declined':
      return 'Skipped, as you asked.';
    case 'expired':
      return 'Not done: the request for your OK expired before you answered. Ask again if you still want it.';
    case 'blocked':
      return 'One step is not allowed here, so it was not done. Ask for it another way, or ask for something else.';
    case 'unavailable':
      return 'A tool this needs is not available right now. Check that its app is connected, then ask again.';
    case 'failed':
      return 'One step failed, so this is not finished. Reply "try again" to retry.';
    case 'budget':
      return 'Stopped after many steps without finishing. Reply "continue" to carry on.';
  }
}

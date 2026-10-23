import { MAX_WRITE_CALLS_PER_TURN } from '../mcp/executeToolCalls';

/** Sent to the model when its reply carried a tool call as text, so that call did not run. */
export const TOOL_MARKUP_RETRY_MESSAGE =
  'That was written as text and did not run. If it is still needed, call the tool.';

/** Result text for a call whose exact action already ran or was refused in this turn. Not run. */
export const REPEATED_ACTION_RESULT =
  'This exact action already ran or was refused in this reply. Do not repeat it; tell the person what happened.';

/** Result text for a write call past the per-turn cap. Not run; the turn ends after this batch. */
export const WRITE_CAP_BLOCKED_RESULT = `Not run: this reply already made the maximum of ${String(MAX_WRITE_CALLS_PER_TURN)} changes. Do not make more changes; tell the person what was changed.`;

/** Ends the turn, shown to the person, when the write cap stopped a call. */
export const WRITE_CAP_STOP_MESSAGE = `Stopped after ${String(MAX_WRITE_CALLS_PER_TURN)} changes in one reply to avoid repeats. Check what was changed, then ask again if you need more.`;

/** Ends the turn, shown to the person, when the model kept sending tool calls that were blocked before they ran. */
export function blockedCallsStopMessage(assistantName: string): string {
  return `${assistantName} kept sending a request in a form the tool cannot take, so this reply stopped. Ask again in other words.`;
}

/** The same stop for a helper, read by the model that started it. */
export const BLOCKED_CALLS_PARENT_MESSAGE =
  'The helper kept sending a request in a form the tool cannot take, so it stopped. Do not send it the same task again. Try another way, or tell the person what could not be done.';

/**
 * Past-tense action claims in first person or as a finished state. Kept short on purpose: a claim
 * only matters when no write call succeeded in the turn, and a false match only adds a note.
 */
const ACTION_CLAIMS: readonly RegExp[] = [
  /\bI(?:['’]ve|\s+have)?\s+(?:just\s+)?(?:created|set|sent|saved|added|scheduled)\b/i,
  /\bhas\s+been\s+(?:created|set|sent|saved|added|scheduled)\b/i,
];

/** Whether a final reply claims an action while no write call succeeded in its turn. */
export function claimsUnbackedAction({ text, successfulWrites }: { text: string; successfulWrites: number }): boolean {
  return successfulWrites === 0 && ACTION_CLAIMS.some(claim => claim.test(text));
}

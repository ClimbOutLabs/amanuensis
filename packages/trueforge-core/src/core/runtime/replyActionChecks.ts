/** Sent to the model once when its reply carried a tool call as text, so the call did not run. */
export const TOOL_MARKUP_RETRY_MESSAGE =
  'Your last tool call was written as text and did not run. Call the tool again using the tool interface.';

/** Ends the turn when the model writes a second tool call as text in the same turn. */
export const TOOL_MARKUP_GIVE_UP_MESSAGE =
  'The model wrote an action as text instead of doing it, so nothing was changed. Try again, or switch to another model in Settings, Models.';

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

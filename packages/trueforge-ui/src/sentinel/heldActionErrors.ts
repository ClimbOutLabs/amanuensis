/**
 * Plain words for everything that can happen when the owner answers a held action. The server says
 * what went wrong by status and `error.code`; its own message text is never shown.
 */

import { stillWorkingText } from '../utils/turnRefusal.js';

export const HELD_EXPIRED_TEXT = 'Expired, nothing was done. Ask again in chat.';

const REFUSAL_TEXT: Record<string, string> = {
  held_action_expired: HELD_EXPIRED_TEXT,
  held_action_changed: 'This no longer matches what was held, so nothing was done. Ask again in chat.',
  held_action_not_allowed: 'This is not allowed any more, so nothing was done. Ask again in chat.',
  held_action_tool_gone: 'This tool is not available any more, so nothing was done. Ask again in chat.',
  held_action_sign_in: 'The connector needs you to sign in again first, so nothing was done. Sign in, then try again.',
};

const GENERIC_FAILURE = 'That did not go through. Try again in a moment.';

export type HeldAnswerFailure =
  /** The action can no longer run; nothing was done and asking again will not help. */
  | { kind: 'refused'; message: string; expired: boolean }
  /** The answer did not reach the server in a way that settles anything; the buttons stay. */
  | { kind: 'retry'; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object';
}

function errorCode(error: Error): string | undefined {
  const body: unknown = Reflect.get(error, 'body');
  const detail = isRecord(body) ? body.error : undefined;
  const code = isRecord(detail) ? detail.code : undefined;
  return typeof code === 'string' ? code : undefined;
}

export function describeHeldAnswerFailure(error: unknown, assistantName: string): HeldAnswerFailure {
  if (!(error instanceof Error)) return { kind: 'retry', message: GENERIC_FAILURE };
  const status: unknown = Reflect.get(error, 'statusCode');
  const code = errorCode(error);
  if (status === 409) {
    const refusal = code === undefined ? undefined : REFUSAL_TEXT[code];
    if (refusal !== undefined) return { kind: 'refused', message: refusal, expired: code === 'held_action_expired' };
    // Nothing was recorded for these, so the buttons stay for another try.
    if (code === 'previous_turn_running') {
      return { kind: 'retry', message: stillWorkingText(assistantName) };
    }
    if (code === 'turn_could_not_start') {
      return { kind: 'retry', message: 'That reply could not start, so nothing was done. Answer again.' };
    }
    return {
      kind: 'refused',
      message: 'This was already answered, or the chat has moved on. Nothing more was done.',
      expired: false,
    };
  }
  if (status === 403) {
    return { kind: 'refused', message: 'Only the person this chat belongs to can answer this.', expired: false };
  }
  if (status === 404 || status === 422) {
    // Includes a saved action whose message was folded away to make room, so it can no longer be found.
    return {
      kind: 'refused',
      message: 'This saved action is no longer available. Ask again in chat.',
      expired: false,
    };
  }
  return { kind: 'retry', message: GENERIC_FAILURE };
}

/** What happened to an approved action, read from the answer's own turn. */
export type HeldActionOutcome = 'done' | 'failed' | 'unclear' | 'not_run';

export const APPROVED_OUTCOME_TEXT: Record<HeldActionOutcome, string> = {
  done: 'Approved and done.',
  failed: 'Approved, but it failed. The details are in the chat.',
  unclear: 'Approved, but it is not clear whether it finished. Check the chat.',
  not_run: 'Approved, but it did not run, so nothing was done. Ask again in chat.',
};

import { apiErrorCode } from './apiErrorCode.js';

/** What the chat says when a new message waits on a reply that is still running. */
export function stillWorkingText(assistantName: string): string {
  return `${assistantName} is still working on your last message. Wait for it to finish, or press Cancel, then send again.`;
}

export const COULD_NOT_START_TEXT = 'That reply could not start. Send your message again.';

export type TurnRefusal = { title: string; description: string };

/**
 * Plain words for a message the server refused (409) because the chat is still answering, or because
 * the reply could not start in time. The server's own text is never shown for these.
 */
export function turnRefusalFor({
  error,
  assistantName,
}: {
  error: unknown;
  assistantName: string;
}): TurnRefusal | undefined {
  const detail = apiErrorCode(error);
  if (detail?.statusCode !== 409) return undefined;
  if (detail.code === 'previous_turn_running') {
    return { title: 'Still working', description: stillWorkingText(assistantName) };
  }
  if (detail.code === 'turn_could_not_start') {
    return { title: 'Reply did not start', description: COULD_NOT_START_TEXT };
  }
  return undefined;
}

/** A refused message, carrying the words the chat shows in place of the server's error. */
export class TurnRefusedError extends Error {
  readonly title: string;

  constructor(refusal: TurnRefusal, options: { cause: unknown }) {
    super(refusal.description, options);
    this.name = 'TurnRefusedError';
    this.title = refusal.title;
  }
}

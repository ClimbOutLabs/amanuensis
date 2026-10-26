import { SESSION_ID_METADATA_KEY } from './markdownMemoryFiles';

/**
 * Whether a recalled note was written in the given chat. The chat's full history is already in the
 * conversation, so an older copy can only mislead. A note with no recorded chat (written before notes
 * recorded one) is judged to be from another chat: a chat title is not unique, so it is never used to guess.
 */
export function isFromSession({
  metadata,
  sessionId,
}: {
  metadata: Readonly<Record<string, string>> | undefined;
  sessionId: string | undefined;
}): boolean {
  return sessionId !== undefined && sessionId !== '' && metadata?.[SESSION_ID_METADATA_KEY] === sessionId;
}

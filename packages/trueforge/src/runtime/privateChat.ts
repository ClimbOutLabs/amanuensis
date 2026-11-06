/**
 * Private chats: a chat Aman does not remember. Every writer that would keep something from a chat
 * asks `sessionKeepsNothing` first. Actions still leave receipts, so approvals and audits never ask.
 */
import type { SessionRecord } from '@truefoundry/trueforge-core/agent-session';

/** A private chat is deleted this long after its last turn if it is not closed first. */
export const PRIVATE_CHAT_LIFETIME_MS = 24 * 60 * 60 * 1000;

export const PRIVATE_CHAT_FLAG_CHANGE_MESSAGE =
  'A chat is incognito from the start or not at all. Start a new incognito chat instead.';

export const PRIVATE_CHAT_FOLDER_MESSAGE =
  'Incognito chats cannot be added to a folder. Start a normal chat to keep it in one.';

export const PRIVATE_CHAT_BUG_REPORT_MESSAGE =
  'Bug reports never include incognito chats. Send a report from Help instead and describe the problem in words.';

export const PRIVATE_CHAT_BRIEF_MESSAGE =
  'Incognito chats are not part of the brief. Mark the item done from the brief chat.';

/** True when nothing from this chat may be written anywhere that outlives it. */
export function sessionKeepsNothing({ session }: { session: Pick<SessionRecord, 'is_incognito'> }): boolean {
  return session.is_incognito;
}

/** When a private chat is deleted, counted from its latest activity. */
export function privateChatExpiry({ from }: { from: Date }): Date {
  return new Date(from.getTime() + PRIVATE_CHAT_LIFETIME_MS);
}

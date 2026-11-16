/**
 * Session metadata key holding the ISO time of the chat's latest finished answer: the last
 * turn that ended with a final message from the persona or the built-in agent. The server
 * stamps it when such a turn finishes; the chat list compares it with the time the person
 * last opened the chat to decide whether the chat carries the unseen-answer dot.
 *
 * Kept apart from the session schema so the browser can read it without the server code that schema pulls in.
 */
export const LATEST_ANSWER_AT_METADATA_KEY = 'latest_answer_at';

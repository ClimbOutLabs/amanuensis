/** Metadata key carrying a memory's provenance, read back at recall to pick a screening posture. */
export const MEMORY_ORIGIN_METADATA_KEY = 'origin';

/**
 * Provenance stamped on every host-written memory:
 * - `user_stated`: the turn produced no untrusted tool output, so the retained exchange is the
 *   user's own voice and the model's reply to it.
 * - `tool_ingested`: the turn ingested at least one tool result. All tool output is untrusted
 *   data (the host says so in the system prompt), so the model's reply may echo injected content;
 *   the recall screen holds such memories to a stricter posture.
 *
 * The external N8N pipeline writes its own origins (`email`, `document`) straight into the bank,
 * bypassing this path entirely; the recall screen treats every origin that is not `user_stated`
 * (those included, and absent legacy metadata) as untrusted, so this union stays the host-written
 * set without having to enumerate the pipeline's.
 */
export type AmanMemoryOrigin = 'user_stated' | 'tool_ingested';

/** The one origin the recall screen trusts as the user's own voice (see AmanMemoryOrigin above). */
export const USER_STATED_ORIGIN = 'user_stated';

/** The origin of a memory written after Aman read an email, document, web page, or tool result. */
export const TOOL_INGESTED_ORIGIN = 'tool_ingested';

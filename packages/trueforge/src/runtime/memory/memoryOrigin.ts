/** Metadata key carrying a memory's provenance, read back at recall to pick a screening posture. */
export const MEMORY_ORIGIN_METADATA_KEY = 'origin';

/**
 * Provenance stamped on every host-written memory:
 * - `user_stated`: the turn produced no untrusted tool output, so the retained exchange is the
 *   user's own voice and the model's reply to it.
 * - `tool_ingested`: the turn ingested at least one tool result. All tool output is untrusted
 *   data (the host says so in the system prompt), so the model's reply may echo injected content;
 *   the recall screen holds such memories to a stricter posture.
 * - `imported`: the text came in through the Memories import, so nobody watched it being said.
 *
 * The external N8N pipeline writes its own origins (`email`, `document`) straight into the bank,
 * bypassing this path entirely. Every reader treats every origin that is not `user_stated`
 * (those included, and a memory with no origin at all) as something read, so this union stays
 * the host-written set without having to enumerate the pipeline's.
 */
export type AmanMemoryOrigin = 'user_stated' | 'tool_ingested' | 'imported';

/** The one origin that counts as the person's own voice. */
export const USER_STATED_ORIGIN = 'user_stated';

/** The origin of a memory written after Aman read an email, document, web page, or tool result. */
export const TOOL_INGESTED_ORIGIN = 'tool_ingested';

/** The origin of a memory that came in through the Memories import. */
export const IMPORTED_ORIGIN = 'imported';

/** The `source` a memory carries when it is a line moved out of a full learned profile. */
export const LEARNED_PROFILE_LINE_SOURCE = 'aman-profile-line';

const HOST_WRITTEN_ORIGINS: readonly AmanMemoryOrigin[] = [USER_STATED_ORIGIN, TOOL_INGESTED_ORIGIN, IMPORTED_ORIGIN];

/** Whether a value is one of the origins the host itself writes. */
function isAmanMemoryOrigin(value: string | undefined): value is AmanMemoryOrigin {
  return HOST_WRITTEN_ORIGINS.some(origin => origin === value);
}

/**
 * Whether a stored memory is the person's own words. Only a memory that says so counts: one with
 * another origin, or with none recorded, is treated as something read.
 */
export function isPersonOrigin(metadata: Readonly<Record<string, string>> | undefined): boolean {
  return metadata?.[MEMORY_ORIGIN_METADATA_KEY] === USER_STATED_ORIGIN;
}

/** Metadata of a memory handed to a save: free-form keys, and always where the memory came from. */
export type RetainMetadata = Record<string, string> & Record<typeof MEMORY_ORIGIN_METADATA_KEY, AmanMemoryOrigin>;

/** Whether every memory handed to a save names a known origin. A save never guesses one. */
export function everyItemNamesOrigin(
  items: readonly { metadata?: Readonly<Record<string, string>> | undefined }[],
): boolean {
  return items.every(item => isAmanMemoryOrigin(item.metadata?.[MEMORY_ORIGIN_METADATA_KEY]));
}

/** What a save is told when a memory names no origin; nothing is stored. */
export const MISSING_ORIGIN_REASON =
  'A memory was not saved because it does not say where it came from. Nothing was stored. Please report this as a bug.';

/**
 * The connectors a person turned off for one chat, kept in the chat's session metadata.
 *
 * Search, email and calendar are on by default in every chat, so a chat's spec cannot say
 * "off": a connector missing from the spec means "never chosen", which now means on. The
 * off choice therefore lives here instead, as the names the person turned off, and the
 * turn setup reads it back on every turn of the chat.
 */

/** Session metadata key for the connectors turned off for a chat. */
export const CHAT_CONNECTORS_OFF_METADATA_KEY = 'connectors_off';

/**
 * The connector names turned off for a chat, from its session metadata. The stored value
 * is a JSON list of names; anything else (missing, unreadable, not a list of names) reads
 * as "nothing turned off", so a damaged value falls back to the default, which is on.
 */
export function readTurnedOffConnectors(metadata: Record<string, string> | null | undefined): string[] {
  if (metadata == null) {
    return [];
  }
  const raw = Reflect.get(metadata, CHAT_CONNECTORS_OFF_METADATA_KEY);
  if (typeof raw !== 'string') {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const names: string[] = [];
  for (const entry of parsed) {
    if (typeof entry === 'string' && entry.length > 0 && !names.includes(entry)) {
      names.push(entry);
    }
  }
  return names;
}

/**
 * The session metadata with the chat's turned-off connectors stored, merged into the
 * metadata the chat already has. An empty list removes the key, so a chat with nothing
 * turned off carries nothing. Session metadata values are capped at 128 characters; the
 * list holds at most the built-in sources (Email, Calendar, the search provider), whose
 * names fit well inside that.
 */
export function withTurnedOffConnectors(
  metadata: Record<string, string> | null | undefined,
  names: readonly string[],
): Record<string, string> {
  const next: Record<string, string> = { ...(metadata ?? {}) };
  const unique = [...new Set(names.filter(name => name.length > 0))];
  if (unique.length === 0) {
    delete next[CHAT_CONNECTORS_OFF_METADATA_KEY];
  } else {
    next[CHAT_CONNECTORS_OFF_METADATA_KEY] = JSON.stringify(unique);
  }
  return next;
}

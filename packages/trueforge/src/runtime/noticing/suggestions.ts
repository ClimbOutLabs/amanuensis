import type { ReachSettings, ReachSuggestion } from '../../schemas/reach';

const ADDRESS = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const MAX_SUGGESTIONS = 20;
const MEMORY_CHARACTERS = 240;

/**
 * Senders worth asking about: each address a memory names that is not already listed or turned down. A suggestion is
 * only a question. Nothing is added until the person accepts it in Settings.
 */
export function suggestAlwaysImportant({
  memories,
  settings,
}: {
  memories: readonly string[];
  settings: Pick<ReachSettings, 'always_important' | 'dismissed_suggestions'>;
}): ReachSuggestion[] {
  const known = new Set([
    ...settings.always_important.map(sender => sender.address),
    ...settings.dismissed_suggestions.map(address => address.toLowerCase()),
  ]);
  const found = new Map<string, ReachSuggestion>();
  for (const memory of memories) {
    for (const match of memory.matchAll(ADDRESS)) {
      const address = match[0].toLowerCase();
      if (known.has(address) || found.has(address)) {
        continue;
      }
      const text = memory.replace(/\s+/g, ' ').trim();
      found.set(address, {
        address,
        memory: text.length <= MEMORY_CHARACTERS ? text : `${text.slice(0, MEMORY_CHARACTERS - 1).trimEnd()}…`,
      });
      if (found.size >= MAX_SUGGESTIONS) {
        return [...found.values()];
      }
    }
  }
  return [...found.values()];
}

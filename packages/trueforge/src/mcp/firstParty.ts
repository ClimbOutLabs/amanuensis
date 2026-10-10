import type { McpServerRecord } from '../db/mcpServerStore';
import type { McpServerManifest } from '../schemas/mcpServer';

function isMemoryProvider(manifest: McpServerManifest): boolean {
  return manifest.type === 'remote' && manifest.memory_provider === true;
}

/**
 * Whether the connector a save leaves behind is first-party: the server's own mark that the
 * product's setup provisioned it, which lets its read-only, explicitly closed-world tools run
 * without asking. The mark lives on the stored record, is never read from a request, and is never
 * derived from a URL. Only the memory provider setup grants it.
 *
 * `memoryProviderChecked` is true only when this very save passed the memory provider connection
 * check. A save that establishes the designation (a new connector, or the flag switched on) is
 * granted the mark. A save that keeps the designation keeps the stored mark only while the URL is
 * unchanged, so repointing a first-party connector drops it until the designation is switched off
 * and on again. Any other save clears it.
 *
 * A connector the server mounts itself, with no stored row, is marked where it is mounted:
 * `firstParty: true` on its tool set.
 */
export function firstPartyAfterSave({
  manifest,
  stored,
  memoryProviderChecked,
}: {
  manifest: McpServerManifest;
  stored: McpServerRecord | undefined;
  memoryProviderChecked: boolean;
}): boolean {
  if (!memoryProviderChecked || !isMemoryProvider(manifest)) {
    return false;
  }
  if (stored === undefined || !isMemoryProvider(stored.manifest)) {
    return true;
  }
  return stored.first_party && stored.manifest.url === manifest.url;
}

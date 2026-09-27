/**
 * Where the server keeps its Markdown memories, from the `memory_defaults` capability the
 * server adds to `GET /api/v1/capabilities` (see `MemoryDefaultsCapability` in
 * `packages/trueforge/src/schemas/capability.ts`). The generated SDK normalizes the wire keys
 * to camelCase before the UI receives them; the snake_case fallback keeps direct host adapters
 * that expose the raw payload working.
 *
 * Never throws: anything short of a non-empty string reads as `null`, and the settings page
 * then says the server did not report a location rather than showing a wrong path. The value
 * is display-only; the directory is server configuration, not a user setting.
 */
import { isObject } from './memoryScreenCapability.js';

/** Reads the SDK-normalized key, falling back to the raw wire key a direct host adapter exposes. */
function read({ raw, camel, snake }: { raw: object; camel: string; snake: string }): unknown {
  const value = Reflect.get(raw, camel);
  return value === undefined ? Reflect.get(raw, snake) : value;
}

/**
 * The server-resolved Markdown memory directory (`MEMORY_MARKDOWN_DIR`), or `null` when the
 * server did not report one (older build, non-admin caller — the server only discloses the
 * host path to admins) or reported something unusable.
 */
export function readMemoryStorageDir(capabilities: unknown): string | null {
  if (!isObject(capabilities)) return null;
  const raw = read({ raw: capabilities, camel: 'memoryDefaults', snake: 'memory_defaults' });
  if (!isObject(raw)) return null;
  const dir = read({ raw, camel: 'markdownDir', snake: 'markdown_dir' });
  return typeof dir === 'string' && dir !== '' ? dir : null;
}

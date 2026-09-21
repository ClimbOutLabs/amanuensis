/**
 * Live meaning-based recall status, from the `memory_embeddings` capability the server adds to
 * `GET /api/v1/capabilities` (see `MemoryEmbeddingsCapability` in
 * `packages/trueforge/src/schemas/capability.ts`). The generated SDK normalizes the wire keys
 * to camelCase before the UI receives them; the snake_case fallback keeps direct host adapters
 * that expose the raw payload working.
 *
 * Never throws: anything short of the complete, well-typed set reads as `null`, and the card
 * then says the status is unavailable rather than showing a wrong one.
 */
import { isObject } from './memoryScreenCapability.js';

export type MemoryEmbeddingsState = 'starting' | 'downloading' | 'backfilling' | 'ready' | 'unavailable';

export interface MemoryEmbeddingsStatus {
  enabled: boolean;
  state: MemoryEmbeddingsState;
  detail: string;
  indexedEntries: number;
}

/** Sound state guard: the switch narrows the string to the literal union, no assertion needed. */
function embeddingsState(value: unknown): MemoryEmbeddingsState | null {
  switch (value) {
    case 'starting':
    case 'downloading':
    case 'backfilling':
    case 'ready':
    case 'unavailable':
      return value;
    default:
      return null;
  }
}

/** Reads the SDK-normalized key, falling back to the raw wire key a direct host adapter exposes. */
function read({ raw, camel, snake }: { raw: object; camel: string; snake: string }): unknown {
  const value = Reflect.get(raw, camel);
  return value === undefined ? Reflect.get(raw, snake) : value;
}

export function readMemoryEmbeddingsStatus(capabilities: unknown): MemoryEmbeddingsStatus | null {
  if (!isObject(capabilities)) return null;
  const raw = read({ raw: capabilities, camel: 'memoryEmbeddings', snake: 'memory_embeddings' });
  if (!isObject(raw)) return null;
  const enabled = read({ raw, camel: 'enabled', snake: 'enabled' });
  const state = embeddingsState(read({ raw, camel: 'state', snake: 'state' }));
  const detail = read({ raw, camel: 'detail', snake: 'detail' });
  const indexedEntries = read({ raw, camel: 'indexedEntries', snake: 'indexed_entries' });
  if (typeof enabled !== 'boolean' || state === null || typeof detail !== 'string') return null;
  if (typeof indexedEntries !== 'number' || !Number.isInteger(indexedEntries) || indexedEntries < 0) {
    return null;
  }
  return { enabled, state, detail, indexedEntries };
}

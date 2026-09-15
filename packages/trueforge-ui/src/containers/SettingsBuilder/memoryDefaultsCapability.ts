/**
 * The server-wide memory defaults, from the `memory_defaults` capability the server adds to
 * `GET /api/v1/capabilities` (see `packages/trueforge/src/schemas/capability.ts`). The generated
 * SDK normalizes the wire keys to camelCase before the UI receives them; the snake_case fallback
 * keeps direct host adapters that expose the raw payload working.
 *
 * Read so the tuning form can show the number a blank field falls back to. Never throws: anything
 * short of the complete, well-typed set reads as `null`, and the form then says "Server default"
 * without a number rather than showing a wrong one.
 */
import type { TrueForgeApi } from '@truefoundry/trueforge-sdk';

import type { MemoryProviderSettings } from '@/server/memoryProviderTypes.js';
import { isReflectBudget } from './memoryProvider.js';
import { isObject } from './memoryScreenCapability.js';

/**
 * The complete set, as the tuning form needs it: every field the server resolved. Includes
 * `recallMinScore`, `recallMaxItems`, and `recallMaxEntities` which are now resolved and reported
 * back through `memory_defaults` (see `MemoryDefaultsCapability` in `packages/trueforge/src/schemas/capability.ts`).
 */
export type MemoryDefaults = Required<
  Pick<
    MemoryProviderSettings,
    | 'recallTimeoutMs'
    | 'recallQueryWindow'
    | 'recallMaxItems'
    | 'recallMaxEntities'
    | 'recallMinScore'
    | 'curatedEnabled'
    | 'curatedMaxModels'
    | 'curatedMaxTokens'
    | 'reflectEnabled'
    | 'reflectBudget'
    | 'reflectMaxTokens'
    | 'reflectTimeoutMs'
  >
>;

type Parser<K extends keyof MemoryDefaults> = (value: unknown) => MemoryDefaults[K] | undefined;

function integer(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

function boolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function reflectBudget(value: unknown): MemoryDefaults['reflectBudget'] | undefined {
  return isReflectBudget(value) ? value : undefined;
}

function fractionalScore(value: unknown): number | undefined {
  return typeof value === 'number' && value >= 0 && value <= 1 ? value : undefined;
}

/**
 * One parser per field. The annotation makes the set complete for the form; `satisfies` ties it
 * to the generated SDK contract, so a field added to or dropped from the capability fails the
 * typecheck here rather than reading as `null` at runtime.
 */
const PARSERS: { [K in keyof MemoryDefaults]: Parser<K> } = {
  recallTimeoutMs: integer,
  recallQueryWindow: integer,
  recallMaxItems: integer,
  recallMaxEntities: integer,
  recallMinScore: fractionalScore,
  curatedEnabled: boolean,
  curatedMaxModels: integer,
  curatedMaxTokens: integer,
  reflectEnabled: boolean,
  reflectBudget,
  reflectMaxTokens: integer,
  reflectTimeoutMs: integer,
} satisfies Record<keyof TrueForgeApi.MemoryDefaultsCapability, unknown>;

const FIELDS = Object.keys(PARSERS) as (keyof MemoryDefaults)[];

/** The wire key of a normalized field: `recallTimeoutMs` is sent as `recall_timeout_ms`. */
function wireKey(camel: string): string {
  return camel.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
}

/** Reads the SDK-normalized key, falling back to the raw wire key a direct host adapter exposes. */
function read({ raw, camel, snake }: { raw: object; camel: string; snake: string }): unknown {
  const value = Reflect.get(raw, camel);
  return value === undefined ? Reflect.get(raw, snake) : value;
}

function readField<K extends keyof MemoryDefaults>(raw: object, key: K): MemoryDefaults[K] | undefined {
  return PARSERS[key](read({ raw, camel: key, snake: wireKey(key) }));
}

export function readMemoryDefaults(capabilities: unknown): MemoryDefaults | null {
  if (!isObject(capabilities)) return null;
  const raw = read({ raw: capabilities, camel: 'memoryDefaults', snake: 'memory_defaults' });
  if (!isObject(raw)) return null;
  const defaults: Partial<MemoryDefaults> = {};
  for (const key of FIELDS) {
    const value = readField(raw, key);
    if (value === undefined) return null;
    Object.assign(defaults, { [key]: value });
  }
  // Every key in FIELDS was set above, or this returned null.
  return defaults as MemoryDefaults;
}

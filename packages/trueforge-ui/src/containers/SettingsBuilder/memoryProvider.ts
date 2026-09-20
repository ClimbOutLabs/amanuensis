/**
 * What both settings surfaces need to know about the memory provider.
 *
 * The provider is stored as an ordinary MCP server row carrying `memory_provider: true`, so
 * `ConnectorSettings` still has to recognise it (to keep it out of its own list, and to resupply
 * the flag on an unrelated credential change) even though `MemorySettings` is what presents and
 * manages it. One owner for the shape rather than the same predicate written twice.
 */
import {
  type MemoryProviderConnector,
  type MemoryProviderCreateRequest,
  type MemoryProviderSettings,
  type MemoryProviderUpdateRequest,
  REFLECT_BUDGETS,
  type ReflectBudget,
} from '@/server/memoryProviderTypes.js';
import type { ConnectorAuth, ConnectorBase } from '@/server/types.js';

export type {
  ConnectorWithMemoryProvider,
  MemoryProviderConnector,
  MemoryProviderCreateRequest,
  MemoryProviderSettings,
  MemoryProviderUpdateRequest,
} from '@/server/memoryProviderTypes.js';

export function isReflectBudget(value: unknown): value is ReflectBudget {
  return typeof value === 'string' && (REFLECT_BUDGETS as readonly string[]).includes(value);
}

function optionalInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

/** As {@link optionalInteger}, for `recallMinScore`, which is a fraction rather than a whole number. */
function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/**
 * Reads the per-bank tuning off the row with runtime checks rather than a cast: `ConnectorBase`
 * does not declare it, and a value that is not the expected shape must read as unset.
 */
export function readMemorySettings(connector: ConnectorBase): MemoryProviderSettings | undefined {
  const raw: unknown = Reflect.get(connector, 'memorySettings');
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const budget = record['reflectBudget'];
  const settings: MemoryProviderSettings = {
    ...pick('recallTimeoutMs', optionalInteger(record['recallTimeoutMs'])),
    ...pick('recallQueryWindow', optionalInteger(record['recallQueryWindow'])),
    ...pick('recallMinScore', optionalNumber(record['recallMinScore'])),
    ...pick('recallMaxItems', optionalInteger(record['recallMaxItems'])),
    ...pick('recallMaxEntities', optionalInteger(record['recallMaxEntities'])),
    ...pick('curatedEnabled', optionalBoolean(record['curatedEnabled'])),
    ...pick('curatedMaxModels', optionalInteger(record['curatedMaxModels'])),
    ...pick('curatedMaxTokens', optionalInteger(record['curatedMaxTokens'])),
    ...pick('reflectEnabled', optionalBoolean(record['reflectEnabled'])),
    ...pick('reflectBudget', isReflectBudget(budget) ? budget : undefined),
    ...pick('reflectMaxTokens', optionalInteger(record['reflectMaxTokens'])),
    ...pick('reflectTimeoutMs', optionalInteger(record['reflectTimeoutMs'])),
    // Wire name, not camelCase: see the field's doc comment in memoryProviderTypes.ts.
    ...pick('screen_enabled', optionalBoolean(record['screen_enabled'])),
    // Wire name, not camelCase: see the field's doc comment in memoryProviderTypes.ts.
    ...pick('prerecall_gate_enabled', optionalBoolean(record['prerecall_gate_enabled'])),
  };
  return Object.keys(settings).length > 0 ? settings : undefined;
}

function pick<K extends keyof MemoryProviderSettings>(
  key: K,
  value: MemoryProviderSettings[K] | undefined,
): Partial<Pick<MemoryProviderSettings, K>> {
  return value === undefined ? {} : ({ [key]: value } as Pick<MemoryProviderSettings, K>);
}

/** Reads the flag off the row rather than asserting it is there: `ConnectorBase` does not declare it. */
export function isMemoryProvider(connector: ConnectorBase): connector is MemoryProviderConnector {
  return Reflect.get(connector, 'memoryProvider') === true;
}

/**
 * A full manifest with the flag set as asked. `updateConnector` replaces the whole manifest, so
 * every caller has to resupply `memoryProvider` or an unrelated edit would silently clear it.
 */
export function memoryProviderUpdateRequest(
  connector: ConnectorBase,
  memoryProvider: boolean,
): MemoryProviderUpdateRequest {
  const memorySettings = readMemorySettings(connector);
  return {
    id: connector.id,
    name: connector.name,
    description: connector.description,
    url: connector.url,
    auth: connector.auth,
    memoryProvider,
    // Resupplied for the same reason as the flag: an unrelated edit must not clear the tuning.
    ...(memorySettings === undefined ? {} : { memorySettings }),
  };
}

/**
 * A create that already carries the flag, so pointing at a bank for the first time is one write
 * the server validates once, rather than a create plus a flag-setting update whose failure would
 * leave an unflagged row behind.
 */
export function memoryProviderCreateRequest(draft: {
  name: string;
  url: string;
  description: string;
  auth: ConnectorAuth;
}): MemoryProviderCreateRequest {
  return { ...draft, memoryProvider: true };
}

export const MEMORY_PROVIDER_URL_PATTERN = /\/mcp\/[^/]+\/?$/;
export const MEMORY_PROVIDER_URL_ERROR = 'A memory provider needs a single-bank MCP URL ending in /mcp/<bank>/';

/**
 * What a person needs to understand about memory, including the Hindsight credential trap that
 * makes a bank look healthy while every recall fails. The long version is in ops/memory/RUNBOOK.md.
 */
export const MEMORY_PROVIDER_NOTES = [
  'The host recalls relevant memories before every model call and retains each finished turn on its own — memory is not a tool the model chooses to call.',
  "The model gets the bank's read tools only, loaded upfront — never its write tools. Nothing to duplicate, and no approval prompt for a save that already happened.",
  'The bank never appears in the connectors list or chat pickers, so there is nothing to leave unselected — it lives here. Chats that already had it attached keep working; start a new chat to drop it.',
  'Every recalled block is visible byte-for-byte in that turn’s events as aman.memory.recall — nothing reaches the model invisibly.',
  'Hindsight can validate different credentials on its MCP surface and its REST API, and memory speaks the REST API. Set HINDSIGHT_API_TENANT_API_KEY (with HINDSIGHT_API_TENANT_EXTENSION set to the builtin ApiKeyTenantExtension) to the same value the MCP surface accepts — otherwise the bank looks connected while every recall fails with HTTP 401 "Invalid API key".',
  'Saving a bank runs a live recall against the REST API and reports the provider’s error when it fails. Re-check any time with Test connection.',
];

/** Joins a message the API wrote to a remediation line without doubling its punctuation. */
export function withRemediation({ message, remediation }: { message: string; remediation: string }): string {
  const trimmed = message.trim();
  if (trimmed === '') {
    return remediation;
  }
  return /[.!?]$/.test(trimmed) ? `${trimmed} ${remediation}` : `${trimmed}. ${remediation}`;
}

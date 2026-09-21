/**
 * What the settings surfaces need to know about the legacy memory-provider connector.
 *
 * The provider is stored as an ordinary MCP server row carrying `memory_provider: true`, so
 * `ConnectorSettings` still has to recognise it (to keep it out of its own list, and to resupply
 * the flag on an unrelated credential change). One owner for the shape rather than the same
 * predicate written twice.
 */
import {
  type MemoryProviderConnector,
  type MemoryProviderSettings,
  type MemoryProviderUpdateRequest,
  REFLECT_BUDGETS,
  type ReflectBudget,
} from '@/server/memoryProviderTypes.js';
import type { ConnectorBase } from '@/server/types.js';

export type {
  ConnectorWithMemoryProvider,
  MemoryProviderConnector,
  MemoryProviderSettings,
  MemoryProviderUpdateRequest,
} from '@/server/memoryProviderTypes.js';

export function isReflectBudget(value: unknown): value is ReflectBudget {
  return typeof value === 'string' && REFLECT_BUDGETS.some(budget => budget === value);
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
  if (!isRecord(raw)) {
    return undefined;
  }
  const settings: MemoryProviderSettings = {};
  const budget = raw['reflectBudget'];
  setIfDefined(settings, 'recallTimeoutMs', optionalInteger(raw['recallTimeoutMs']));
  setIfDefined(settings, 'recallQueryWindow', optionalInteger(raw['recallQueryWindow']));
  setIfDefined(settings, 'recallMinScore', optionalNumber(raw['recallMinScore']));
  setIfDefined(settings, 'recallMaxItems', optionalInteger(raw['recallMaxItems']));
  setIfDefined(settings, 'recallMaxEntities', optionalInteger(raw['recallMaxEntities']));
  setIfDefined(settings, 'curatedEnabled', optionalBoolean(raw['curatedEnabled']));
  setIfDefined(settings, 'curatedMaxModels', optionalInteger(raw['curatedMaxModels']));
  setIfDefined(settings, 'curatedMaxTokens', optionalInteger(raw['curatedMaxTokens']));
  setIfDefined(settings, 'reflectEnabled', optionalBoolean(raw['reflectEnabled']));
  setIfDefined(settings, 'reflectBudget', isReflectBudget(budget) ? budget : undefined);
  setIfDefined(settings, 'reflectMaxTokens', optionalInteger(raw['reflectMaxTokens']));
  setIfDefined(settings, 'reflectTimeoutMs', optionalInteger(raw['reflectTimeoutMs']));
  // Wire name, not camelCase: see the field's doc comment in memoryProviderTypes.ts.
  setIfDefined(settings, 'screen_enabled', optionalBoolean(raw['screen_enabled']));
  // Wire name, not camelCase: see the field's doc comment in memoryProviderTypes.ts.
  setIfDefined(settings, 'prerecall_gate_enabled', optionalBoolean(raw['prerecall_gate_enabled']));
  return Object.keys(settings).length > 0 ? settings : undefined;
}

/** A non-null object whose string keys can be read safely; `ConnectorBase` leaves them undeclared. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function setIfDefined<K extends keyof MemoryProviderSettings>(
  settings: MemoryProviderSettings,
  key: K,
  value: MemoryProviderSettings[K] | undefined,
): void {
  if (value !== undefined) {
    settings[key] = value;
  }
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

/** Joins a message the API wrote to a remediation line without doubling its punctuation. */
export function withRemediation({ message, remediation }: { message: string; remediation: string }): string {
  const trimmed = message.trim();
  if (trimmed === '') {
    return remediation;
  }
  return /[.!?]$/.test(trimmed) ? `${trimmed} ${remediation}` : `${trimmed}. ${remediation}`;
}

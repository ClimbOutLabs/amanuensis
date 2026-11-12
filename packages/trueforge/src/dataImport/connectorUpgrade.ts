import { isRecord } from './lenient';

/** Connector fields an older export wrote that no connector carries any more. */
const RETIRED_MANIFEST_KEYS = new Set(['memory_provider', 'memory_settings']);

/**
 * Brings a connectors section from an older export up to today's shape before the strict read, by
 * dropping fields that no longer exist. Nothing a person sees is changed.
 */
export function upgradeArchivedConnectors(json: unknown): unknown {
  if (!Array.isArray(json)) {
    return json;
  }
  const records: unknown[] = json;
  return records.map(record => {
    if (!isRecord(record) || !isRecord(record['manifest'])) {
      return record;
    }
    const manifest = Object.fromEntries(
      Object.entries(record['manifest']).filter(([key]) => !RETIRED_MANIFEST_KEYS.has(key)),
    );
    return { ...record, manifest };
  });
}

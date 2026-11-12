import { createDisplayPreference } from './displayPreference.js';

/** A per-browser on/off display switch. */
export function createBooleanDisplayPreference({
  storageKey,
  defaultValue,
}: {
  storageKey: string;
  defaultValue: boolean;
}) {
  return createDisplayPreference({
    storageKey,
    defaultValue,
    parse: stored => stored === 'true',
    serialize: String,
  });
}

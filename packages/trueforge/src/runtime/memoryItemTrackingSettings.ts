import { extractErrorLogFields } from '@truefoundry/trueforge-core/core';
import type { Logger } from 'winston';

import type { IGlobalSettingsStore } from '../db/globalSettingsStore';

/**
 * Global-settings key for the persisted item-tracking override.
 * Stored values are the strings `'true'` / `'false'`; anything else reads as unset.
 */
export const MEMORY_ITEM_TRACKING_SETTING_KEY = 'memory_item_tracking_enabled';

export interface MemoryItemTrackingSetting {
  /** The stored setting: the persisted override when present, else the default. */
  enabled: boolean;
  /** Whether a persisted override is currently stored. */
  overridden: boolean;
  /** The default used when no override is stored: tracking is on. */
  defaultEnabled: boolean;
}

export interface ReadMemoryItemTrackingSettingDeps {
  globalSettingsStore: IGlobalSettingsStore;
  logger: Logger;
}

function parseOverride(value: string): boolean | undefined {
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  return undefined;
}

/**
 * The item-tracking stored setting: the persisted override when one is stored, otherwise on.
 * A stored value that is not exactly `'true'`/`'false'` is treated as unset. Fails to the
 * default when the store read throws, so a settings-table outage never silently flips it.
 * Switching it off stops item tracking only: the diary and the brief's other inputs are
 * untouched, and the items file keeps what it already holds.
 */
export async function readMemoryItemTrackingSetting(
  deps: ReadMemoryItemTrackingSettingDeps,
): Promise<MemoryItemTrackingSetting> {
  const unset: MemoryItemTrackingSetting = { enabled: true, overridden: false, defaultEnabled: true };
  let record;
  try {
    record = await deps.globalSettingsStore.getSetting({ key: MEMORY_ITEM_TRACKING_SETTING_KEY });
  } catch (error) {
    deps.logger.warn('Global setting read failed; using the default for item tracking', extractErrorLogFields(error));
    return unset;
  }
  if (record === undefined) {
    return unset;
  }
  const override = parseOverride(record.value);
  if (override === undefined) {
    deps.logger.warn('Ignoring malformed item-tracking override; using the default', { value: record.value });
    return unset;
  }
  return { enabled: override, overridden: true, defaultEnabled: true };
}

/** On/off for one turn: the stored setting, read fresh so a change in Settings applies without a restart. */
export async function resolveMemoryItemTrackingEnabled(deps: ReadMemoryItemTrackingSettingDeps): Promise<boolean> {
  const setting = await readMemoryItemTrackingSetting(deps);
  return setting.enabled;
}

import { extractErrorLogFields } from '@truefoundry/trueforge-core/core';
import type { Logger } from 'winston';

import configuration from '../config';
import type { IGlobalSettingsStore } from '../db/globalSettingsStore';
import type { MemoryProviderSettings } from '../schemas/mcpServer';

/**
 * Global-settings key for the persisted recall screen override.
 * Stored values are the strings `'true'` / `'false'`; anything else reads as unset.
 */
export const MEMORY_SCREEN_ENABLED_SETTING_KEY = 'memory_screen_enabled';

export interface MemoryScreenSetting {
  /** The stored setting: the persisted override when present, else the env default. */
  enabled: boolean;
  /** Whether a persisted override is currently stored. */
  overridden: boolean;
  /** The `MEMORY_SCREEN_ENABLED` env default used when no override is stored. */
  defaultEnabled: boolean;
}

export interface ReadMemoryScreenSettingDeps {
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
 * The recall screen's stored setting: the persisted override when one is stored,
 * otherwise `MEMORY_SCREEN_ENABLED`. A stored value that is not exactly
 * `'true'`/`'false'` is treated as unset. Fails closed to the env default when the
 * store read throws, so a settings-table outage can never silently flip screening.
 *
 * This is the stored setting, NOT the effective runtime state: recall screening is
 * effectively off when no screening service is configured (`MEMORY_SCREEN_URL` unset),
 * even when the stored setting says on. See `resolveMemoryScreenEnabled`.
 */
export async function readMemoryScreenSetting(deps: ReadMemoryScreenSettingDeps): Promise<MemoryScreenSetting> {
  const defaultEnabled = configuration.MEMORY_SCREEN_ENABLED;
  const unset: MemoryScreenSetting = { enabled: defaultEnabled, overridden: false, defaultEnabled };
  let record;
  try {
    record = await deps.globalSettingsStore.getSetting({ key: MEMORY_SCREEN_ENABLED_SETTING_KEY });
  } catch (error) {
    deps.logger.warn(
      'Global setting read failed; using the env default for the recall screen',
      extractErrorLogFields(error),
    );
    return unset;
  }
  if (record === undefined) {
    return unset;
  }
  const override = parseOverride(record.value);
  if (override === undefined) {
    deps.logger.warn('Ignoring malformed recall screen override; using the env default', {
      value: record.value,
    });
    return unset;
  }
  return { enabled: override, overridden: true, defaultEnabled };
}

/**
 * Effective on/off for turn runtime construction: the stored setting AND a configured
 * screening service (`MEMORY_SCREEN_URL` set). With no classifier to call there is
 * nothing to screen, so recall screening is effectively off. The stored override is
 * preserved verbatim; it takes effect again as soon as a screening service is configured.
 */
export async function resolveMemoryScreenEnabled(deps: ReadMemoryScreenSettingDeps): Promise<boolean> {
  const setting = await readMemoryScreenSetting(deps);
  return setting.enabled && configuration.MEMORY_SCREEN_URL !== '';
}

/**
 * Applies the Settings toggle's persisted recall-screen override to the per-bank memory
 * settings. The override wins when stored; otherwise the settings pass through unchanged.
 * Both turn-creation paths use this so the toggle and the capability resolve identically.
 */
export function applyMemoryScreenOverride(
  settings: MemoryProviderSettings | undefined,
  override: boolean | undefined,
): MemoryProviderSettings | undefined {
  if (override === undefined) {
    return settings;
  }
  return { ...settings, screen_enabled: override };
}

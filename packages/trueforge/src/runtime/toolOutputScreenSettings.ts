import { extractErrorLogFields } from '@truefoundry/trueforge-core/core';
import type { Logger } from 'winston';

import configuration from '../config';
import type { IGlobalSettingsStore } from '../db/globalSettingsStore';

/**
 * Global-settings key for the persisted live tool-output screen override.
 * Stored values are the strings `'true'` / `'false'`; anything else reads as unset.
 */
export const TOOL_OUTPUT_SCREEN_ENABLED_SETTING_KEY = 'tool_output_screen_enabled';

export interface ToolOutputScreenSetting {
  /** The stored setting: the persisted override when present, else the env default. */
  enabled: boolean;
  /** Whether a persisted override is currently stored. */
  overridden: boolean;
  /** The `TOOL_OUTPUT_SCREEN_ENABLED` env default used when no override is stored. */
  defaultEnabled: boolean;
}

export interface ReadToolOutputScreenSettingDeps {
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
 * The live tool-output screen's stored setting: the persisted override when one is
 * stored, otherwise `TOOL_OUTPUT_SCREEN_ENABLED`. A stored value that is not exactly
 * `'true'`/`'false'` is treated as unset. Fails closed to the env default when the
 * store read throws, so a settings-table outage can never silently flip screening.
 *
 * This is the stored setting, NOT the effective runtime state: screening is
 * effectively off when no screening service is configured (`MEMORY_SCREEN_URL` unset),
 * even when the stored setting says on. See `resolveToolOutputScreenEnabled`.
 */
export async function readToolOutputScreenSetting(
  deps: ReadToolOutputScreenSettingDeps,
): Promise<ToolOutputScreenSetting> {
  const defaultEnabled = configuration.TOOL_OUTPUT_SCREEN_ENABLED;
  const unset: ToolOutputScreenSetting = { enabled: defaultEnabled, overridden: false, defaultEnabled };
  let record;
  try {
    record = await deps.globalSettingsStore.getSetting({ key: TOOL_OUTPUT_SCREEN_ENABLED_SETTING_KEY });
  } catch (error) {
    deps.logger.warn(
      'Global setting read failed; using the env default for the tool-output screen',
      extractErrorLogFields(error),
    );
    return unset;
  }
  if (record === undefined) {
    return unset;
  }
  const override = parseOverride(record.value);
  if (override === undefined) {
    deps.logger.warn('Ignoring malformed tool-output screen override; using the env default', {
      value: record.value,
    });
    return unset;
  }
  return { enabled: override, overridden: true, defaultEnabled };
}

/**
 * Effective on/off for turn runtime construction: the stored setting AND a configured
 * screening service (`MEMORY_SCREEN_URL` set). With no classifier to call there is
 * nothing to screen, so screening is effectively off — the withholder is never
 * attached, and a stored ON override can never silently withhold every open-world
 * tool result. The stored override is preserved verbatim; it takes effect again as
 * soon as a screening service is configured.
 */
export async function resolveToolOutputScreenEnabled(deps: ReadToolOutputScreenSettingDeps): Promise<boolean> {
  const setting = await readToolOutputScreenSetting(deps);
  return setting.enabled && configuration.MEMORY_SCREEN_URL !== '';
}

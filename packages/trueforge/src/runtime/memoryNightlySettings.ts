import { extractErrorLogFields } from '@truefoundry/trueforge-core/core';
import type { Logger } from 'winston';

import configuration from '../config';
import type { IGlobalSettingsStore } from '../db/globalSettingsStore';

/** Global-settings key for the stored nightly-job override. Values are `'true'` / `'false'`; anything else reads as unset. */
export const MEMORY_NIGHTLY_SETTING_KEY = 'memory_nightly_job_enabled';

/** Global-settings key for the hour of the server's day the tidy-up starts at, `0` to `23`; anything else reads as unset. */
export const MEMORY_NIGHTLY_HOUR_SETTING_KEY = 'memory_nightly_job_hour';

/** Midnight on the server's clock, used until the person picks another hour. */
export const DEFAULT_MEMORY_NIGHTLY_HOUR = 0;

/** The hour a stored value names, or undefined when it is not a whole hour of the day. */
export function parseNightlyHour(value: string): number | undefined {
  return /^(?:\d|1\d|2[0-3])$/.test(value) ? Number(value) : undefined;
}

export interface MemoryNightlySetting {
  /** The stored setting: the persisted override when present, else the env default. */
  enabled: boolean;
  /** Whether a persisted override is currently stored. */
  overridden: boolean;
  /** The `MEMORY_NIGHTLY_JOB` env default used when no override is stored. */
  defaultEnabled: boolean;
  /** The hour of the server's day, 0 to 23, the tidy-up starts at. */
  hour: number;
}

export interface ReadMemoryNightlySettingDeps {
  globalSettingsStore: IGlobalSettingsStore;
  logger: Logger;
}

/**
 * The nightly-job setting, read each time the timer looks at the clock so a change in Settings applies
 * without a restart. A failed read falls back to the env default rather than switching the job on.
 */
export async function readMemoryNightlySetting(deps: ReadMemoryNightlySettingDeps): Promise<MemoryNightlySetting> {
  const defaultEnabled = configuration.MEMORY_NIGHTLY_JOB;
  const unset: MemoryNightlySetting = {
    enabled: defaultEnabled,
    overridden: false,
    defaultEnabled,
    hour: DEFAULT_MEMORY_NIGHTLY_HOUR,
  };
  let record;
  try {
    record = await deps.globalSettingsStore.getSetting({ key: MEMORY_NIGHTLY_SETTING_KEY });
    const storedHour = await deps.globalSettingsStore.getSetting({ key: MEMORY_NIGHTLY_HOUR_SETTING_KEY });
    unset.hour = (storedHour === undefined ? undefined : parseNightlyHour(storedHour.value)) ?? unset.hour;
  } catch (error) {
    deps.logger.warn(
      'Global setting read failed; using the env default for the nightly job',
      extractErrorLogFields(error),
    );
    return unset;
  }
  if (record === undefined) {
    return unset;
  }
  if (record.value !== 'true' && record.value !== 'false') {
    deps.logger.warn('Ignoring malformed nightly-job override; using the env default', { value: record.value });
    return unset;
  }
  const override = record.value === 'true';
  return {
    enabled: override,
    overridden: true,
    defaultEnabled,
    hour: unset.hour,
  };
}

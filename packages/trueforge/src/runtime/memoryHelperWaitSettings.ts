import { extractErrorLogFields } from '@truefoundry/trueforge-core/core';
import type { Logger } from 'winston';

import type { IGlobalSettingsStore } from '../db/globalSettingsStore';

/** Global-settings key for how many minutes a sorting or tidying question may wait for the model; anything but `1` to `60` reads as unset. */
export const MEMORY_HELPER_WAIT_SETTING_KEY = 'memory_helper_model_wait_minutes';

/** Long enough for a slow model that is still answering; the model client gives up sooner on one that went silent. */
export const DEFAULT_MEMORY_HELPER_WAIT_MINUTES = 10;

export const MAX_MEMORY_HELPER_WAIT_MINUTES = 60;

/** The minutes a stored value names, or undefined when it is not a whole number from 1 to 60. */
export function parseHelperWaitMinutes(value: string): number | undefined {
  const minutes = /^\d{1,2}$/.test(value) ? Number(value) : undefined;
  return minutes !== undefined && minutes >= 1 && minutes <= MAX_MEMORY_HELPER_WAIT_MINUTES ? minutes : undefined;
}

/** Read for each question, so a change in Settings applies without a restart. A failed read gives the default. */
export async function readMemoryHelperWaitMinutes({
  globalSettingsStore,
  logger,
}: {
  globalSettingsStore: IGlobalSettingsStore;
  logger: Logger;
}): Promise<number> {
  try {
    const stored = await globalSettingsStore.getSetting({ key: MEMORY_HELPER_WAIT_SETTING_KEY });
    return (
      (stored === undefined ? undefined : parseHelperWaitMinutes(stored.value)) ?? DEFAULT_MEMORY_HELPER_WAIT_MINUTES
    );
  } catch (error) {
    logger.warn(
      'Global setting read failed; using the default wait for memory helper questions',
      extractErrorLogFields(error),
    );
    return DEFAULT_MEMORY_HELPER_WAIT_MINUTES;
  }
}

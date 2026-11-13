import { extractErrorLogFields } from '@truefoundry/trueforge-core/core';
import type { Logger } from 'winston';

import configuration from '../config';
import type { IGlobalSettingsStore } from '../db/globalSettingsStore';
import { PageSortModeSchema, type PageSortMode } from './memory/pageSortMode';

/** Global-settings key for the stored page-sorting override. Anything but `off`, `report` or `on` reads as unset. */
export const MEMORY_PAGE_SORTING_SETTING_KEY = 'memory_page_sorting_mode';

export interface MemoryPageSortingSetting {
  /** The stored setting: the persisted override when present, else the env default. */
  mode: PageSortMode;
  /** Whether a persisted override is currently stored. */
  overridden: boolean;
  /** The `MEMORY_PAGE_SORTING` env default used when no override is stored. */
  defaultMode: PageSortMode;
}

export interface ReadMemoryPageSortingSettingDeps {
  globalSettingsStore: IGlobalSettingsStore;
  logger: Logger;
}

/**
 * The page-sorting setting, read each time the sorter is about to work so a change in Settings applies
 * without a restart. A failed read falls back to the env default.
 */
export async function readMemoryPageSortingSetting(
  deps: ReadMemoryPageSortingSettingDeps,
): Promise<MemoryPageSortingSetting> {
  const defaultMode = configuration.MEMORY_PAGE_SORTING;
  const unset: MemoryPageSortingSetting = {
    mode: defaultMode,
    overridden: false,
    defaultMode,
  };
  let record;
  try {
    record = await deps.globalSettingsStore.getSetting({ key: MEMORY_PAGE_SORTING_SETTING_KEY });
  } catch (error) {
    deps.logger.warn(
      'Global setting read failed; using the env default for page sorting',
      extractErrorLogFields(error),
    );
    return unset;
  }
  if (record === undefined) {
    return unset;
  }
  const parsed = PageSortModeSchema.safeParse(record.value);
  if (!parsed.success) {
    deps.logger.warn('Ignoring malformed page-sorting override; using the env default', { value: record.value });
    return unset;
  }
  return {
    mode: parsed.data,
    overridden: true,
    defaultMode,
  };
}

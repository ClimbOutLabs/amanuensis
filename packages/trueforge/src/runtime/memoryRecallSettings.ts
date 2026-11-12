import { extractErrorLogFields } from '@truefoundry/trueforge-core/core';
import type { Logger } from 'winston';

import type { IGlobalSettingsStore } from '../db/globalSettingsStore';

/**
 * Global-settings key for the person-level "use memories in replies" switch. It is the one owner
 * of that choice: when stored, it wins over every agent's own memory setting.
 * Stored values are the strings `'true'` / `'false'`; anything else reads as unset.
 */
export const MEMORY_RECALL_ENABLED_SETTING_KEY = 'memory_recall_enabled';

/**
 * The stored switch, or undefined when nothing valid is stored, so the agent's own setting applies.
 * A failed read also gives undefined: an outage must not turn recall off for people who left it on.
 */
export async function readMemoryRecallSetting(deps: {
  globalSettingsStore: IGlobalSettingsStore;
  logger: Logger;
}): Promise<boolean | undefined> {
  let record;
  try {
    record = await deps.globalSettingsStore.getSetting({ key: MEMORY_RECALL_ENABLED_SETTING_KEY });
  } catch (error) {
    deps.logger.warn(
      'Global setting read failed; memory recall follows the agent setting',
      extractErrorLogFields(error),
    );
    return undefined;
  }
  if (record?.value === 'true') {
    return true;
  }
  if (record?.value === 'false') {
    return false;
  }
  if (record !== undefined) {
    deps.logger.warn('Ignoring malformed memory recall switch; memory recall follows the agent setting', {
      value: record.value,
    });
  }
  return undefined;
}

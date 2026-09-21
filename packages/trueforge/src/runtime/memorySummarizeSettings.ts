import { extractErrorLogFields } from '@truefoundry/trueforge-core/core';
import type { Logger } from 'winston';

import configuration from '../config';
import type { IGlobalSettingsStore } from '../db/globalSettingsStore';

/**
 * Global-settings key for the persisted turn-summarization override.
 * Stored values are the strings `'true'` / `'false'`; anything else reads as unset.
 */
export const MEMORY_SUMMARIZE_SETTING_KEY = 'memory_summarize_enabled';

export interface MemorySummarizeSetting {
  /** The stored setting: the persisted override when present, else the env default. */
  enabled: boolean;
  /** Whether a persisted override is currently stored. */
  overridden: boolean;
  /** The `MEMORY_SUMMARIZE` env default used when no override is stored. */
  defaultEnabled: boolean;
  /**
   * What the server will actually do for the next turn: the stored setting ANDed with
   * the markdown-only gate. This is the truth the Settings toggle shows — on any other
   * backend turns are retained verbatim even when `enabled` is true.
   */
  effectiveEnabled: boolean;
}

export interface ReadMemorySummarizeSettingDeps {
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
 * The markdown-only gate, owned here: summarization runs only on the markdown backend.
 * `beginTurnExecution` and the effective-state computation both go through this so the
 * Settings toggle can never disagree with what the turn path actually does.
 */
export function isMemorySummarizeEffective(enabled: boolean): boolean {
  return enabled && configuration.MEMORY_BACKEND === 'markdown';
}

/**
 * The turn-summarization stored setting: the persisted override when one is stored,
 * otherwise `MEMORY_SUMMARIZE`. A stored value that is not exactly `'true'`/`'false'`
 * is treated as unset. Fails closed to the env default when the store read throws, so
 * a settings-table outage can never silently flip summarization.
 *
 * The returned `enabled` is the stored setting (override else env default); `effectiveEnabled`
 * is what the server will actually do, with the markdown-only gate applied. See
 * `beginTurnExecution`.
 */
export async function readMemorySummarizeSetting(
  deps: ReadMemorySummarizeSettingDeps,
): Promise<MemorySummarizeSetting> {
  const defaultEnabled = configuration.MEMORY_SUMMARIZE;
  const unset: MemorySummarizeSetting = {
    enabled: defaultEnabled,
    overridden: false,
    defaultEnabled,
    effectiveEnabled: isMemorySummarizeEffective(defaultEnabled),
  };
  let record;
  try {
    record = await deps.globalSettingsStore.getSetting({ key: MEMORY_SUMMARIZE_SETTING_KEY });
  } catch (error) {
    deps.logger.warn(
      'Global setting read failed; using the env default for turn summarization',
      extractErrorLogFields(error),
    );
    return unset;
  }
  if (record === undefined) {
    return unset;
  }
  const override = parseOverride(record.value);
  if (override === undefined) {
    deps.logger.warn('Ignoring malformed turn-summarization override; using the env default', {
      value: record.value,
    });
    return unset;
  }
  return {
    enabled: override,
    overridden: true,
    defaultEnabled,
    effectiveEnabled: isMemorySummarizeEffective(override),
  };
}

/**
 * Effective on/off for turn construction: the stored setting. Unlike screening there is
 * no external service to AND in — summarization degrades to the verbatim transcript on
 * its own when the model call fails — so the stored value is the effective value. The
 * markdown-only gate stays in the turn path (`beginTurnExecution`), which also logs why
 * a non-markdown backend retains turns verbatim.
 */
export async function resolveMemorySummarizeEnabled(deps: ReadMemorySummarizeSettingDeps): Promise<boolean> {
  const setting = await readMemorySummarizeSetting(deps);
  return setting.enabled;
}

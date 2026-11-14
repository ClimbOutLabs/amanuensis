import { extractErrorLogFields } from '@truefoundry/trueforge-core/core';
import type { Logger } from 'winston';

import type { IGlobalSettingsStore } from '../db/globalSettingsStore';
import type { IModelProviderStore } from '../db/modelProviderStore';

/** Global-settings key for the model that does the background work after a chat. Unset means the chat's own model. */
export const MEMORY_HELPER_MODEL_SETTING_KEY = 'memory_helper_model';

export const MAX_HELPER_MODEL_NAME_CHARS = 300;

/** The stored name as written, also when the model is no longer listed, so Settings can say so. */
export async function readStoredHelperModel({
  globalSettingsStore,
}: {
  globalSettingsStore: IGlobalSettingsStore;
}): Promise<string | undefined> {
  const stored = (await globalSettingsStore.getSetting({ key: MEMORY_HELPER_MODEL_SETTING_KEY }))?.value.trim();
  return stored === undefined || stored === '' ? undefined : stored;
}

/**
 * The helper model to use now. A stored model that is no longer listed counts as unset, so background work goes
 * on with the chat's model instead of failing on every question. A failed read counts as unset too.
 */
export async function readMemoryHelperModel({
  tenantId,
  globalSettingsStore,
  modelProviderStore,
  logger,
}: {
  tenantId: string;
  globalSettingsStore: IGlobalSettingsStore;
  modelProviderStore: Pick<IModelProviderStore, 'listModels'>;
  logger: Logger;
}): Promise<string | undefined> {
  try {
    const stored = await readStoredHelperModel({ globalSettingsStore });
    if (stored === undefined) {
      return undefined;
    }
    const models = await modelProviderStore.listModels({ tenant_id: tenantId });
    if (models.some(model => model.name === stored)) {
      return stored;
    }
    logger.warn('The chosen helper model is no longer listed; background work uses the chat model', {
      model: stored,
    });
    return undefined;
  } catch (error) {
    logger.warn('The helper model setting could not be read; background work uses the chat model', {
      ...extractErrorLogFields(error),
    });
    return undefined;
  }
}

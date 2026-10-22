import type { Logger } from 'winston';

import type { IGlobalSettingsStore } from '../db/globalSettingsStore';
import type { IModelProviderStore } from '../db/modelProviderStore';
import { putDefaultModelFirst, readDefaultChatModel } from './tokenFactoryProvider';

/**
 * The model a new chat starts on, which is the model its turns run on unless a persona says otherwise.
 * It is the stored default when the catalog still lists it, else the first listed model, the same order
 * the model list and the chat picker use. Custom providers and connector-supplied models are in the catalog
 * too, so they count without a stored default.
 */
export async function resolveDefaultChatModel({
  tenantId,
  modelProviderStore,
  globalSettingsStore,
  logger,
}: {
  tenantId: string;
  modelProviderStore: Pick<IModelProviderStore, 'listModels'>;
  globalSettingsStore: IGlobalSettingsStore;
  logger: Logger;
}): Promise<string | undefined> {
  const models = await modelProviderStore.listModels({ tenant_id: tenantId });
  const defaultName = await readDefaultChatModel({ globalSettingsStore, logger });
  return putDefaultModelFirst(models, defaultName)[0]?.name;
}

import { AgentSpecSchema, type AgentSpec } from '@truefoundry/trueforge-core/agent-session';
import type { Logger } from 'winston';

import type { IGlobalSettingsStore } from '../db/globalSettingsStore';
import type { IModelProviderStore } from '../db/modelProviderStore';
import type { AvailableModel } from '../schemas/modelProvider';
import { putDefaultModelFirst, readDefaultChatModel } from './tokenFactoryProvider';

/**
 * The model a new chat starts on, which is the model its turns run on unless a persona says otherwise.
 * It is the stored default when the catalog still lists it, else the first listed model, the same order
 * the model list and the chat picker use. Custom providers and connector-supplied models are in the catalog
 * too, so they count without a stored default.
 */
export async function resolveDefaultChatModelEntry({
  tenantId,
  modelProviderStore,
  globalSettingsStore,
  logger,
}: {
  tenantId: string;
  modelProviderStore: Pick<IModelProviderStore, 'listModels'>;
  globalSettingsStore: IGlobalSettingsStore;
  logger: Logger;
}): Promise<AvailableModel | undefined> {
  const models = await modelProviderStore.listModels({ tenant_id: tenantId });
  const defaultName = await readDefaultChatModel({ globalSettingsStore, logger });
  return putDefaultModelFirst(models, defaultName)[0];
}

/** The name of the model a new chat starts on. */
export async function resolveDefaultChatModel(
  input: Parameters<typeof resolveDefaultChatModelEntry>[0],
): Promise<string | undefined> {
  return (await resolveDefaultChatModelEntry(input))?.name;
}

/**
 * The assistant a new chat in the app starts on, for a chat the server opens itself: the default model at its lowest
 * real reasoning effort, with the sandbox on when the server has one. The app's default skills build pages in the
 * sandbox and are left out here.
 */
export function newChatAgentSpec({
  model,
  sandbox,
}: {
  model: AvailableModel | undefined;
  sandbox: boolean;
}): AgentSpec | undefined {
  if (model === undefined) {
    return undefined;
  }
  const efforts = model.properties.reasoning_efforts;
  // Catalog lists are ordered lowest first, as in the app's model picker.
  const effort = efforts?.find(value => value !== 'none') ?? efforts?.[0];
  return AgentSpecSchema.parse({
    model: { name: model.name, ...(effort === undefined ? {} : { params: { reasoning_effort: effort } }) },
    config: { sandbox: { enabled: sandbox } },
  });
}

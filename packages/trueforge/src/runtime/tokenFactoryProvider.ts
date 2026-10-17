import { extractErrorLogFields } from '@truefoundry/trueforge-core/core';
import { isDeepStrictEqual } from 'node:util';
import type { Logger } from 'winston';

import type { IGlobalSettingsStore } from '../db/globalSettingsStore';
import type { IModelProviderStore } from '../db/modelProviderStore';
import { NameSchema } from '../schemas/common';
import { modelProviderName, type AvailableModel, type ModelProviderManifest } from '../schemas/modelProvider';

/** Resource name of the env-managed provider: well-known providers are named after their type. */
export const TOKEN_FACTORY_PROVIDER_NAME = 'tokenfactory';

/** Global-settings key holding the fully qualified `provider/model` the chat picker starts on. */
export const DEFAULT_CHAT_MODEL_SETTING_KEY = 'default_chat_model';

/** Inputs of the env-managed provider, read from `NEBIUS_API_KEY` and the `TOKEN_FACTORY_*` settings. */
export interface TokenFactorySettings {
  apiKey: string | undefined;
  baseUrl: string;
  model: string;
  cheaperModel: string | undefined;
}

/** Model resource names are hyphen-only, so `org/Model_Name` becomes `model-name`. */
export function tokenFactoryModelName(modelId: string): string {
  const base = modelId.slice(modelId.lastIndexOf('/') + 1).toLowerCase();
  const hyphenated = base.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return NameSchema.parse(/^[a-z]/.test(hyphenated) ? hyphenated.slice(0, 64) : `m-${hyphenated}`.slice(0, 64));
}

function hasApiKey(apiKey: string | undefined): apiKey is string {
  return apiKey !== undefined && apiKey.trim() !== '';
}

/**
 * Names of the providers whose record the server derives from its environment, so the API can
 * mark them and refuse edits that the next restart would overwrite. Empty when TrueFoundry owns
 * the provider list.
 */
export function envManagedModelProviderNames(options: {
  apiKey: string | undefined;
  managedByTrueFoundry: boolean;
}): ReadonlySet<string> {
  return hasApiKey(options.apiKey) && !options.managedByTrueFoundry
    ? new Set([TOKEN_FACTORY_PROVIDER_NAME])
    : new Set();
}

/** The `tokenfactory` manifest for the env settings: default model first, optional cheaper model second. */
export function buildEnvManagedTokenFactoryManifest(
  settings: TokenFactorySettings & { apiKey: string },
): ModelProviderManifest {
  const modelIds =
    settings.cheaperModel === undefined || settings.cheaperModel === settings.model
      ? [settings.model]
      : [settings.model, settings.cheaperModel];
  return {
    type: 'tokenfactory',
    base_url: settings.baseUrl,
    auth: { api_key: settings.apiKey },
    models: modelIds.map(modelId => ({ model_id: modelId, name: tokenFactoryModelName(modelId), properties: {} })),
  };
}

/** Fully qualified name of the env-managed default model, as the chat picker lists it. */
export function envManagedDefaultModelName(model: string): string {
  return `${TOKEN_FACTORY_PROVIDER_NAME}/${tokenFactoryModelName(model)}`;
}

export type EnvManagedProviderOutcome = 'skipped' | 'unchanged' | 'upserted';

/**
 * Makes the `tokenfactory` provider record match the environment at startup. One row keyed by
 * `(tenant_id, name)` is replaced in place, so restarts never duplicate it; a rotated key or a
 * changed model takes effect on the next boot. A stream deadline and the models an earlier record
 * carried are kept.
 */
export async function ensureEnvManagedTokenFactoryProvider({
  store,
  tenant_id,
  settings,
  logger,
}: {
  store: IModelProviderStore;
  tenant_id: string;
  settings: TokenFactorySettings;
  logger: Logger;
}): Promise<EnvManagedProviderOutcome> {
  const { apiKey } = settings;
  if (!hasApiKey(apiKey)) {
    return 'skipped';
  }
  const existing = await store.getProvider({ tenant_id, name: TOKEN_FACTORY_PROVIDER_NAME, model_name: '' });
  const built = buildEnvManagedTokenFactoryManifest({ ...settings, apiKey });
  // Models an earlier boot registered stay listed, so roles, personas and agents that still point
  // at a replaced default keep resolving after an upgrade or an env change.
  const desiredNames = new Set(built.models.map(model => model.name));
  const desired: ModelProviderManifest = {
    ...built,
    models: [...built.models, ...(existing?.manifest.models ?? []).filter(model => !desiredNames.has(model.name))],
  };
  const manifest: ModelProviderManifest =
    existing?.manifest.stream_timeout === undefined || desired.type !== 'tokenfactory'
      ? desired
      : { ...desired, stream_timeout: existing.manifest.stream_timeout };
  if (existing !== undefined && isDeepStrictEqual(existing.manifest, manifest)) {
    return 'unchanged';
  }
  await store.upsertProvider({ tenant_id, name: modelProviderName(manifest), manifest });
  logger.info('Token Factory provider synced from the environment', {
    models: manifest.models.map(model => model.model_id),
  });
  return 'upserted';
}

/**
 * Makes the env-managed default model the chat default when nothing else is. A stored default
 * that points at another provider is left alone; one that points at this provider is refreshed so
 * a changed `TOKEN_FACTORY_MODEL` takes effect.
 */
export async function seedEnvManagedDefaultChatModel({
  globalSettingsStore,
  model,
  logger,
}: {
  globalSettingsStore: IGlobalSettingsStore;
  model: string;
  logger: Logger;
}): Promise<void> {
  const desired = envManagedDefaultModelName(model);
  const stored = await globalSettingsStore.getSetting({ key: DEFAULT_CHAT_MODEL_SETTING_KEY });
  if (stored?.value === desired) {
    return;
  }
  if (stored !== undefined && !stored.value.startsWith(`${TOKEN_FACTORY_PROVIDER_NAME}/`)) {
    logger.info('Keeping the existing default chat model', { default_chat_model: stored.value });
    return;
  }
  await globalSettingsStore.setSetting({ key: DEFAULT_CHAT_MODEL_SETTING_KEY, value: desired });
}

/** The stored default chat model; a failed read means no default rather than a failed model list. */
export async function readDefaultChatModel({
  globalSettingsStore,
  logger,
}: {
  globalSettingsStore: IGlobalSettingsStore;
  logger: Logger;
}): Promise<string | undefined> {
  try {
    return (await globalSettingsStore.getSetting({ key: DEFAULT_CHAT_MODEL_SETTING_KEY }))?.value;
  } catch (error) {
    logger.warn('Default chat model read failed; listing models in provider order', extractErrorLogFields(error));
    return undefined;
  }
}

/** Moves the default chat model to the front, keeping every other model in its order. */
export function putDefaultModelFirst(models: AvailableModel[], defaultName: string | undefined): AvailableModel[] {
  if (defaultName === undefined) {
    return models;
  }
  return [...models.filter(model => model.name === defaultName), ...models.filter(model => model.name !== defaultName)];
}

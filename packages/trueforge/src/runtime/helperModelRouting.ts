import { envManagedDefaultModelName, TOKEN_FACTORY_PROVIDER_NAME } from './tokenFactoryProvider';

/**
 * The small model that does helper jobs (memory summary, profile learning, library checks), as a
 * `provider/model` name. Defined only while the env-managed Token Factory provider lists a second
 * model, so a local-only setup and a TrueFoundry-managed one never get one.
 */
export function envManagedHelperModelFqn({
  apiKey,
  managedByTrueFoundry,
  model,
  cheaperModel,
}: {
  apiKey: string | undefined;
  managedByTrueFoundry: boolean;
  model: string;
  cheaperModel: string | undefined;
}): string | undefined {
  if (managedByTrueFoundry || apiKey === undefined || apiKey.trim() === '') {
    return undefined;
  }
  if (cheaperModel === undefined || cheaperModel === model) {
    return undefined;
  }
  return envManagedDefaultModelName(cheaperModel);
}

/**
 * Sends a helper job to the small model when the turn itself runs on Token Factory; any other
 * provider keeps its own model, since a local server may run only one. Callers apply an explicit
 * role setting before this, so the owner's choice always wins.
 */
export function routeHelperModel(input: { modelFqn: string; helperFqn: string | undefined }): string;
export function routeHelperModel(input: {
  modelFqn: string | undefined;
  helperFqn: string | undefined;
}): string | undefined;
export function routeHelperModel({
  modelFqn,
  helperFqn,
}: {
  modelFqn: string | undefined;
  helperFqn: string | undefined;
}): string | undefined {
  if (helperFqn !== undefined && modelFqn?.startsWith(`${TOKEN_FACTORY_PROVIDER_NAME}/`) === true) {
    return helperFqn;
  }
  return modelFqn;
}

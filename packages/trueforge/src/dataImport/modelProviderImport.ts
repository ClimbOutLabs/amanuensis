/**
 * Plans how an export's model providers land on this instance, shared by the
 * dry run (which only reports) and the real import (which writes the plan).
 *
 * An export carries setups without keys, so a restored provider may still
 * need its key; the plan says which ones. A provider already here under the
 * same name (the one the environment keeps, above all) keeps its key and
 * any models the export does not name.
 */
import type { ModelProviderRecord } from '../db/modelProviderStore';
import type { ModelProviderManifest } from '../schemas/modelProvider';
import type { ImportModelProviderRecord } from './importSchemas';

/** One provider to write, with the manifest it lands as. */
export interface PlannedModelProvider {
  name: string;
  manifest: ModelProviderManifest;
  /** True when the provider lands without a key, so its models cannot answer yet. */
  needsKey: boolean;
}

export interface ModelProviderImportPlan {
  /** Providers to write, in the order the export listed them. */
  writes: PlannedModelProvider[];
  /** Every model name a persona can point at after the import, as `provider/model`. */
  availableModels: string[];
  /** The model a persona is moved to when its own is not available after the import. */
  fallbackModel: string | undefined;
}

/** A persona whose model did not survive the import, and the model it runs on instead. */
export interface PersonaModelSwitch {
  personaId: string;
  personaName: string;
  modelName: string;
}

/**
 * The setup an imported provider lands with: the imported setup wins, a key
 * already here is kept (an export never carries one), and models already
 * here stay listed unless the import names the same model or upstream id.
 */
export function mergeImportedProvider(input: {
  imported: ModelProviderManifest;
  existing: ModelProviderManifest | undefined;
}): ModelProviderManifest {
  const { imported, existing } = input;
  if (existing === undefined) {
    return imported;
  }
  const importedNames = new Set(imported.models.map(model => model.name));
  const importedIds = new Set(imported.models.map(model => model.model_id));
  const kept = existing.models.filter(model => !importedNames.has(model.name) && !importedIds.has(model.model_id));
  const models = [...imported.models, ...kept];
  return existing.auth === undefined ? { ...imported, models } : { ...imported, models, auth: existing.auth };
}

export function planModelProviderImport(input: {
  imported: readonly ImportModelProviderRecord[];
  existing: readonly ModelProviderRecord[];
  /** The instance's default model once the import's settings land; the instance's own value wins. */
  defaultModel: string | undefined;
}): ModelProviderImportPlan {
  const existingByName = new Map(input.existing.map(record => [record.name, record.manifest]));
  const writes: PlannedModelProvider[] = input.imported.map(entry => {
    const manifest = mergeImportedProvider({ imported: entry.manifest, existing: existingByName.get(entry.name) });
    return { name: entry.name, manifest, needsKey: manifest.auth?.api_key === undefined };
  });
  const finalByName = new Map(existingByName);
  for (const write of writes) {
    finalByName.set(write.name, write.manifest);
  }
  const availableModels: string[] = [];
  for (const name of [...finalByName.keys()].sort()) {
    const manifest = finalByName.get(name);
    if (manifest === undefined) {
      continue;
    }
    for (const model of manifest.models) {
      availableModels.push(`${name}/${model.name}`);
    }
  }
  const fallbackModel =
    input.defaultModel !== undefined && availableModels.includes(input.defaultModel)
      ? input.defaultModel
      : availableModels[0];
  return { writes, availableModels, fallbackModel };
}

/**
 * Personas whose model is not available after the import move to the
 * fallback model, so no persona is left pointing at a model that is not
 * here. With no model available at all there is nothing to move to, and the
 * persona keeps the name it had.
 */
export function planPersonaModelSwitches(input: {
  personas: readonly { id: string; display_name: string; model_name: string | null }[];
  plan: ModelProviderImportPlan;
}): PersonaModelSwitch[] {
  const available = new Set(input.plan.availableModels);
  const switches: PersonaModelSwitch[] = [];
  for (const persona of input.personas) {
    if (persona.model_name === null || available.has(persona.model_name)) {
      continue;
    }
    if (input.plan.fallbackModel === undefined) {
      continue;
    }
    switches.push({ personaId: persona.id, personaName: persona.display_name, modelName: input.plan.fallbackModel });
  }
  return switches;
}

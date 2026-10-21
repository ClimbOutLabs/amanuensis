/**
 * The part of a model provider that travels in a data export: its type, its
 * address and its models, rebuilt field by field from an allowlist. The key
 * and anything else a provider record may hold never reach the archive, so
 * an imported provider comes back set up and waiting for its key.
 */
import { z } from 'zod';

import type { ModelProviderRecord } from '../db/modelProviderStore';
import { NameSchema } from '../schemas/common';
import {
  ConfiguredModelSchema,
  ModelProviderStreamTimeoutSchema,
  ModelProviderTypeSchema,
  type ModelProperties,
  type ModelProviderStreamTimeout,
} from '../schemas/modelProvider';
import type { ExportScrubber } from './secretScrub';

/** The one owner of an exported provider setup's shape; the type below is derived from it. */
export const ExportedModelProviderManifestSchema = z.object({
  type: ModelProviderTypeSchema,
  base_url: z.string(),
  models: z.array(ConfiguredModelSchema),
  stream_timeout: ModelProviderStreamTimeoutSchema.optional(),
  /** Only a custom provider carries a name of its own. */
  name: NameSchema.optional(),
});
export type ExportedModelProviderManifest = z.infer<typeof ExportedModelProviderManifestSchema>;

export const ExportedModelProviderSchema = z.object({
  name: NameSchema,
  manifest: ExportedModelProviderManifestSchema,
});
export type ExportedModelProvider = z.infer<typeof ExportedModelProviderSchema>;

/** One model entry of a provider manifest. */
type ConfiguredModel = z.infer<typeof ConfiguredModelSchema>;

function exportableProperties(properties: ModelProperties): ModelProperties {
  return {
    ...(properties.context_length === undefined ? {} : { context_length: properties.context_length }),
    ...(properties.max_output_tokens === undefined ? {} : { max_output_tokens: properties.max_output_tokens }),
    ...(properties.reasoning_efforts === undefined ? {} : { reasoning_efforts: [...properties.reasoning_efforts] }),
    ...(properties.vision === undefined ? {} : { vision: properties.vision }),
  };
}

function exportableModel(model: ConfiguredModel, scrubText: (text: string) => string): ConfiguredModel {
  return { model_id: scrubText(model.model_id), name: model.name, properties: exportableProperties(model.properties) };
}

function exportableStreamTimeout(streamTimeout: ModelProviderStreamTimeout): ModelProviderStreamTimeout {
  return {
    ...(streamTimeout.first_chunk_ms === undefined ? {} : { first_chunk_ms: streamTimeout.first_chunk_ms }),
    ...(streamTimeout.chunk_ms === undefined ? {} : { chunk_ms: streamTimeout.chunk_ms }),
  };
}

/**
 * Builds one provider's export entry. The scrubber's JSON pass never rewrites
 * identity fields (ids and names), so the provider's name and each model id
 * are scrubbed here, in the projection: a key pasted into either would
 * otherwise travel verbatim.
 */
export function exportableModelProvider(record: ModelProviderRecord, scrub: ExportScrubber): ExportedModelProvider {
  const { manifest } = record;
  return {
    name: scrub.text(record.name),
    manifest: {
      type: manifest.type,
      base_url: scrub.url(manifest.base_url),
      models: manifest.models.map(model => exportableModel(model, text => scrub.text(text))),
      ...(manifest.type === 'custom' ? { name: scrub.text(manifest.name) } : {}),
      ...(manifest.stream_timeout === undefined
        ? {}
        : { stream_timeout: exportableStreamTimeout(manifest.stream_timeout) }),
    },
  };
}

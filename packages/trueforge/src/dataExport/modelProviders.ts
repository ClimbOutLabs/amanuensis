/**
 * The part of a model provider that travels in a data export: its type, its
 * address and its models, rebuilt field by field from an allowlist. The key
 * and anything else a provider record may hold never reach the archive, so
 * an imported provider comes back set up and waiting for its key.
 */
import type { ModelProviderRecord } from '../db/modelProviderStore';
import type {
  ConfiguredModel,
  ModelProperties,
  ModelProviderStreamTimeout,
  ModelProviderType,
} from '../schemas/modelProvider';

export interface ExportedModelProvider {
  name: string;
  manifest: ExportedModelProviderManifest;
}

export interface ExportedModelProviderManifest {
  type: ModelProviderType;
  base_url: string;
  models: ConfiguredModel[];
  stream_timeout?: ModelProviderStreamTimeout;
  /** Only a custom provider carries a name of its own. */
  name?: string;
}

function exportableProperties(properties: ModelProperties): ModelProperties {
  return {
    ...(properties.context_length === undefined ? {} : { context_length: properties.context_length }),
    ...(properties.max_output_tokens === undefined ? {} : { max_output_tokens: properties.max_output_tokens }),
    ...(properties.reasoning_efforts === undefined ? {} : { reasoning_efforts: [...properties.reasoning_efforts] }),
    ...(properties.vision === undefined ? {} : { vision: properties.vision }),
  };
}

function exportableModel(model: ConfiguredModel): ConfiguredModel {
  return { model_id: model.model_id, name: model.name, properties: exportableProperties(model.properties) };
}

function exportableStreamTimeout(streamTimeout: ModelProviderStreamTimeout): ModelProviderStreamTimeout {
  return {
    ...(streamTimeout.first_chunk_ms === undefined ? {} : { first_chunk_ms: streamTimeout.first_chunk_ms }),
    ...(streamTimeout.chunk_ms === undefined ? {} : { chunk_ms: streamTimeout.chunk_ms }),
  };
}

/** `scrubUrl` removes any credentials embedded in the address before it is written. */
export function exportableModelProvider(
  record: ModelProviderRecord,
  scrubUrl: (url: string) => string,
): ExportedModelProvider {
  const { manifest } = record;
  return {
    name: record.name,
    manifest: {
      type: manifest.type,
      base_url: scrubUrl(manifest.base_url),
      models: manifest.models.map(exportableModel),
      ...(manifest.type === 'custom' ? { name: manifest.name } : {}),
      ...(manifest.stream_timeout === undefined
        ? {}
        : { stream_timeout: exportableStreamTimeout(manifest.stream_timeout) }),
    },
  };
}

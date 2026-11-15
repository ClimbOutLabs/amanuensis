/**
 * The part of a model provider that travels in a data export: its type, its
 * address and its models, rebuilt field by field from an allowlist. The key
 * and anything else a provider record may hold never reach the archive, so
 * an imported provider comes back set up and waiting for its key.
 */
import type { z } from 'zod';

import { ImportModelProviderRecordSchema, type ImportModelProviderRecord } from '../dataImport/importSchemas';
import type { ModelProviderRecord } from '../db/modelProviderStore';
import type { ConfiguredModelSchema, ModelProperties, ModelProviderStreamTimeout } from '../schemas/modelProvider';
import type { ExportScrubber } from './secretScrub';

/** One model entry of a provider manifest. */
type ConfiguredModel = z.infer<typeof ConfiguredModelSchema>;

function exportableProperties(properties: ModelProperties): ModelProperties {
  return {
    ...(properties.context_length === undefined ? {} : { context_length: properties.context_length }),
    ...(properties.max_output_tokens === undefined ? {} : { max_output_tokens: properties.max_output_tokens }),
    ...(properties.reasoning_efforts === undefined ? {} : { reasoning_efforts: [...properties.reasoning_efforts] }),
    ...(properties.vision === undefined ? {} : { vision: properties.vision }),
    ...(properties.max_concurrent_requests === undefined
      ? {}
      : { max_concurrent_requests: properties.max_concurrent_requests }),
  };
}

function exportableStreamTimeout(streamTimeout: ModelProviderStreamTimeout): ModelProviderStreamTimeout {
  return {
    ...(streamTimeout.first_chunk_ms === undefined ? {} : { first_chunk_ms: streamTimeout.first_chunk_ms }),
    ...(streamTimeout.chunk_ms === undefined ? {} : { chunk_ms: streamTimeout.chunk_ms }),
  };
}

/**
 * Builds one provider's export entry, or null when it is left out. Names and model ids are identities the import
 * reads back as they are, so a secret in one cannot be redacted in place: `[redacted]` is not a valid name, and two
 * redacted ids would collide. A model whose id or name holds a secret is left out, and so is a provider whose name
 * holds one. The entry is then checked against the import's own schema, the one owner of the archive's shape, so an
 * export never writes a provider that would make the import refuse the whole section.
 */
export function exportableModelProvider(
  record: ModelProviderRecord,
  scrub: ExportScrubber,
): ImportModelProviderRecord | null {
  const { manifest } = record;
  if (scrub.holdsSecret(record.name) || (manifest.type === 'custom' && scrub.holdsSecret(manifest.name))) {
    return null;
  }
  const models = manifest.models
    .filter(model => !scrub.holdsSecret(model.model_id) && !scrub.holdsSecret(model.name))
    .map((model: ConfiguredModel): ConfiguredModel => ({
      model_id: model.model_id,
      name: model.name,
      properties: exportableProperties(model.properties),
    }));
  const parsed = ImportModelProviderRecordSchema.safeParse({
    name: record.name,
    manifest: {
      type: manifest.type,
      base_url: scrub.url(manifest.base_url),
      models,
      ...(manifest.type === 'custom' ? { name: manifest.name } : {}),
      ...(manifest.stream_timeout === undefined
        ? {}
        : { stream_timeout: exportableStreamTimeout(manifest.stream_timeout) }),
    },
  });
  return parsed.success ? parsed.data : null;
}

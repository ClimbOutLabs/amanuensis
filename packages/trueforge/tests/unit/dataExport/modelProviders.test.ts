/**
 * The export projection for a model provider: an allowlist, so only the setup
 * (type, address, models) can travel and nothing a provider record holds
 * besides that ever reaches the archive.
 */
import { exportableModelProvider } from '../../../src/dataExport/modelProviders';
import { createExportScrubber } from '../../../src/dataExport/secretScrub';
import { ImportModelProviderRecordSchema, type ImportModelProviderRecord } from '../../../src/dataImport/importSchemas';
import type { ModelProviderRecord } from '../../../src/db/modelProviderStore';

const PLANTED_KEY = 'FAKE-KEY-planted-in-the-provider-record';
const PLANTED_PASSWORD = 'FAKE-PASSWORD-planted-in-the-address';

function record(manifest: ModelProviderRecord['manifest'], name: string): ModelProviderRecord {
  return {
    tenant_id: 'default',
    name,
    manifest,
    created_at: '2026-10-16T12:00:00.000Z',
    updated_at: '2026-10-16T12:00:00.000Z',
  };
}

// Built at run time so the file itself never holds a key-shaped string.
const shapedKey = ['sk', 'planted'.repeat(3) + '12'].join('-');

const scrub = createExportScrubber([]);

function exportOf(provider: ModelProviderRecord, using = scrub): ImportModelProviderRecord {
  const exported = exportableModelProvider(provider, using);
  if (exported === null) throw new Error('the provider was left out of the export');
  return exported;
}

describe('exportableModelProvider', () => {
  it('carries the setup of a well-known provider and drops its key', () => {
    const exported = exportOf(
      record(
        {
          type: 'openai',
          base_url: 'https://api.openai.com/v1',
          auth: { api_key: PLANTED_KEY },
          models: [
            {
              model_id: 'gpt-test',
              name: 'gpt-test',
              properties: {
                context_length: 128000,
                max_output_tokens: 4096,
                reasoning_efforts: ['low'],
                vision: true,
                max_concurrent_requests: 2,
              },
            },
          ],
          stream_timeout: { first_chunk_ms: 1000, chunk_ms: 2000 },
        },
        'openai',
      ),
      scrub,
    );
    expect(exported).toEqual({
      name: 'openai',
      manifest: {
        type: 'openai',
        base_url: 'https://api.openai.com/v1',
        models: [
          {
            model_id: 'gpt-test',
            name: 'gpt-test',
            properties: {
              context_length: 128000,
              max_output_tokens: 4096,
              reasoning_efforts: ['low'],
              vision: true,
              max_concurrent_requests: 2,
            },
          },
        ],
        stream_timeout: { first_chunk_ms: 1000, chunk_ms: 2000 },
      },
    });
    expect(JSON.stringify(exported)).not.toContain(PLANTED_KEY);
    expect(JSON.stringify(exported)).not.toContain('auth');
  });

  it('keeps a custom provider name and drops its key', () => {
    const exported = exportOf(
      record(
        {
          type: 'custom',
          name: 'lab-box',
          base_url: 'https://llm.internal.example.com/v1',
          auth: { api_key: PLANTED_KEY },
          models: [{ model_id: 'local-1', name: 'local-1', properties: {} }],
        },
        'lab-box',
      ),
      scrub,
    );
    expect(exported.name).toBe('lab-box');
    expect(exported.manifest).toEqual({
      type: 'custom',
      name: 'lab-box',
      base_url: 'https://llm.internal.example.com/v1',
      models: [{ model_id: 'local-1', name: 'local-1', properties: {} }],
    });
    expect(JSON.stringify(exported)).not.toContain(PLANTED_KEY);
  });

  it('strips credentials embedded in the provider address', () => {
    const exported = exportOf(
      record(
        {
          type: 'custom',
          name: 'lab-box',
          base_url: `https://user:${PLANTED_PASSWORD}@llm.internal.example.com/v1`,
          models: [{ model_id: 'local-1', name: 'local-1', properties: {} }],
        },
        'lab-box',
      ),
      scrub,
    );
    expect(exported.manifest.base_url).toBe('https://llm.internal.example.com/v1');
    expect(JSON.stringify(exported)).not.toContain(PLANTED_PASSWORD);
  });

  it('copies only the known model property fields', () => {
    const exported = exportOf(
      record(
        {
          type: 'anthropic',
          base_url: 'https://api.anthropic.com/v1',
          auth: { api_key: PLANTED_KEY },
          models: [{ model_id: 'claude-test', name: 'claude-test', properties: { vision: false } }],
        },
        'anthropic',
      ),
      scrub,
    );
    expect(exported.manifest.models).toEqual([
      { model_id: 'claude-test', name: 'claude-test', properties: { vision: false } },
    ]);
    expect('stream_timeout' in exported.manifest).toBe(false);
  });

  it('leaves out a provider whose name holds a key, so the key never travels and the import still reads the file', () => {
    const knowingScrub = createExportScrubber([PLANTED_KEY]);
    const exported = exportableModelProvider(
      record(
        {
          type: 'custom',
          name: PLANTED_KEY,
          base_url: 'https://llm.internal.example.com/v1',
          models: [{ model_id: 'local-1', name: 'local-1', properties: {} }],
        },
        PLANTED_KEY,
      ),
      knowingScrub,
    );
    expect(exported).toBeNull();
    expect(knowingScrub.redactionCount()).toBeGreaterThan(0);
  });

  it('leaves out a model whose id or name holds a key and keeps the rest of the provider', () => {
    const knowingScrub = createExportScrubber([PLANTED_KEY]);
    const exported = exportOf(
      record(
        {
          type: 'custom',
          name: 'lab-box',
          base_url: 'https://llm.internal.example.com/v1',
          models: [
            { model_id: PLANTED_KEY, name: 'local-1', properties: {} },
            { model_id: 'local-2', name: PLANTED_KEY, properties: {} },
            { model_id: 'local-3', name: 'local-3', properties: {} },
          ],
        },
        'lab-box',
      ),
      knowingScrub,
    );
    expect(exported.manifest.models).toEqual([{ model_id: 'local-3', name: 'local-3', properties: {} }]);
    expect(JSON.stringify(exported)).not.toContain(PLANTED_KEY);
    expect(ImportModelProviderRecordSchema.safeParse(exported).success).toBe(true);
  });

  it('leaves out a credential-shaped model id even when it is not a stored key', () => {
    const exported = exportOf(
      record(
        {
          type: 'openai',
          base_url: 'https://api.openai.com/v1',
          models: [
            { model_id: shapedKey, name: 'gpt-test', properties: {} },
            { model_id: 'gpt-other', name: 'gpt-other', properties: {} },
          ],
        },
        'openai',
      ),
    );
    expect(exported.manifest.models.map(model => model.model_id)).toEqual(['gpt-other']);
    expect(JSON.stringify(exported)).not.toContain(shapedKey);
  });

  it('never writes a provider the import would refuse', () => {
    const leftWithNothing = exportableModelProvider(
      record(
        {
          type: 'openai',
          base_url: 'https://api.openai.com/v1',
          models: [{ model_id: shapedKey, name: 'gpt-test', properties: {} }],
        },
        'openai',
      ),
      scrub,
    );
    expect(leftWithNothing === null || ImportModelProviderRecordSchema.safeParse(leftWithNothing).success).toBe(true);
    const misnamed = exportableModelProvider(
      record(
        {
          type: 'custom',
          name: 'lab-box',
          base_url: 'https://llm.internal.example.com/v1',
          models: [{ model_id: 'local-1', name: 'local-1', properties: {} }],
        },
        'other-name',
      ),
      scrub,
    );
    expect(misnamed).toBeNull();
  });
});

/**
 * The export projection for a model provider: an allowlist, so only the setup
 * (type, address, models) can travel and nothing a provider record holds
 * besides that ever reaches the archive.
 */
import { exportableModelProvider } from '../../../src/dataExport/modelProviders';
import { createExportScrubber } from '../../../src/dataExport/secretScrub';
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

const scrub = createExportScrubber([]);

describe('exportableModelProvider', () => {
  it('carries the setup of a well-known provider and drops its key', () => {
    const exported = exportableModelProvider(
      record(
        {
          type: 'openai',
          base_url: 'https://api.openai.com/v1',
          auth: { api_key: PLANTED_KEY },
          models: [
            {
              model_id: 'gpt-test',
              name: 'gpt-test',
              properties: { context_length: 128000, max_output_tokens: 4096, reasoning_efforts: ['low'], vision: true },
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
            properties: { context_length: 128000, max_output_tokens: 4096, reasoning_efforts: ['low'], vision: true },
          },
        ],
        stream_timeout: { first_chunk_ms: 1000, chunk_ms: 2000 },
      },
    });
    expect(JSON.stringify(exported)).not.toContain(PLANTED_KEY);
    expect(JSON.stringify(exported)).not.toContain('auth');
  });

  it('keeps a custom provider name and drops its key', () => {
    const exported = exportableModelProvider(
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
    const exported = exportableModelProvider(
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
    const exported = exportableModelProvider(
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

  it('scrubs a key pasted into the provider name and a model id', () => {
    const knowingScrub = createExportScrubber([PLANTED_KEY]);
    const exported = exportableModelProvider(
      record(
        {
          type: 'custom',
          name: PLANTED_KEY,
          base_url: 'https://llm.internal.example.com/v1',
          auth: { api_key: PLANTED_KEY },
          models: [{ model_id: PLANTED_KEY, name: 'local-1', properties: {} }],
        },
        PLANTED_KEY,
      ),
      knowingScrub,
    );
    expect(exported.name).toBe('[redacted]');
    expect(exported.manifest).toEqual({
      type: 'custom',
      name: '[redacted]',
      base_url: 'https://llm.internal.example.com/v1',
      models: [{ model_id: '[redacted]', name: 'local-1', properties: {} }],
    });
    expect(JSON.stringify(exported)).not.toContain(PLANTED_KEY);
  });

  it('scrubs a credential-shaped model id even when it is not a stored key', () => {
    const shapedKey = 'sk-plantedplantedplanted12';
    const exported = exportableModelProvider(
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
    expect(exported.manifest.models[0]?.model_id).toBe('[redacted]');
    expect(JSON.stringify(exported)).not.toContain(shapedKey);
  });
});

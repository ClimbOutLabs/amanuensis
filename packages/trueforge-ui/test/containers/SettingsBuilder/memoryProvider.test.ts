import { TrueForge } from '@truefoundry/trueforge-sdk';
import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { z } from 'zod';

import {
  isMemoryProvider,
  memoryProviderUpdateRequest,
  readMemorySettings,
} from '@/containers/SettingsBuilder/memoryProvider.js';
import { createConnectorCatalog } from '@/plugins/trueforge-agent-server-adapter/catalogs/connectorCatalog.js';

// Every per-bank setting, in the snake_case shape the server stores and sends.
const WIRE_MEMORY_SETTINGS = {
  curated_enabled: true,
  curated_max_models: 3,
  curated_max_tokens: 800,
  prerecall_gate_enabled: true,
  recall_max_entities: 4,
  recall_max_items: 12,
  recall_min_score: 0.35,
  recall_query_window: 3,
  recall_timeout_ms: 6_000,
  reflect_budget: 'low',
  reflect_enabled: false,
  reflect_max_tokens: 900,
  reflect_timeout_ms: 20_000,
  screen_enabled: true,
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

const WrittenManifestSchema = z.object({ manifest: z.object({ memory_settings: z.unknown() }) });

function configuredServer(memorySettings: Record<string, unknown>) {
  return {
    name: 'hindsight',
    manifest: {
      type: 'remote',
      name: 'hindsight',
      description: 'Long-term memory',
      url: 'https://memory.example/mcp/default/',
      memory_provider: true,
      memory_settings: memorySettings,
    },
    auth_status: { status: 'not_required' },
  };
}

describe('memory provider settings through the SDK', () => {
  function catalogServing(memorySettings: Record<string, unknown>) {
    const writes: { method: string | undefined; body: unknown }[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET') {
        return jsonResponse({ data: [configuredServer(memorySettings)] });
      }
      writes.push({ method, body: JSON.parse(String(init?.body)) });
      return jsonResponse({ data: configuredServer(memorySettings) });
    };
    const client = new TrueForge({ baseUrl: 'http://harness.test', maxRetries: 0, fetch: fetchImpl });
    return { catalog: createConnectorCatalog(client, { baseUrl: 'http://harness.test', fetch: fetchImpl }), writes };
  }

  it('keeps every per-bank setting when an unrelated edit rewrites the connector', async () => {
    const { catalog, writes } = catalogServing(WIRE_MEMORY_SETTINGS);

    const [connector] = await catalog.listConnectors({});
    assert.ok(connector !== undefined && isMemoryProvider(connector));
    await catalog.updateConnector(memoryProviderUpdateRequest(connector, true));

    assert.equal(writes.length, 1);
    const written = WrittenManifestSchema.parse(writes[0]?.body);
    assert.deepEqual(written.manifest.memory_settings, WIRE_MEMORY_SETTINGS);
  });

  it('reads the screening and pre-recall gate switches the SDK delivers', async () => {
    const { catalog } = catalogServing({ screen_enabled: false, prerecall_gate_enabled: true });

    const [connector] = await catalog.listConnectors({});

    assert.ok(connector !== undefined);
    assert.deepEqual(readMemorySettings(connector), { screenEnabled: false, prerecallGateEnabled: true });
  });
});

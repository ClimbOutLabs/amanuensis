import { describe, expect, it } from 'vitest';

import { readMemoryDefaults } from '@/containers/SettingsBuilder/memoryDefaultsCapability.js';

const wire = {
  backend: 'markdown',
  recall_timeout_ms: 2500,
  recall_query_window: 5,
  recall_max_items: 50,
  recall_max_entities: 10,
  recall_min_score: 0.6,
  curated_enabled: true,
  curated_max_models: 3,
  curated_max_tokens: 512,
  reflect_enabled: true,
  reflect_budget: 'low',
  reflect_max_tokens: 512,
  reflect_timeout_ms: 8000,
};
const normalized = {
  backend: 'markdown',
  recallTimeoutMs: 2500,
  recallQueryWindow: 5,
  recallMaxItems: 50,
  recallMaxEntities: 10,
  recallMinScore: 0.6,
  curatedEnabled: true,
  curatedMaxModels: 3,
  curatedMaxTokens: 512,
  reflectEnabled: true,
  reflectBudget: 'low',
  reflectMaxTokens: 512,
  reflectTimeoutMs: 8000,
};

describe('readMemoryDefaults', () => {
  it('reads the SDK-normalized camelCase field', () => {
    expect(readMemoryDefaults({ memoryDefaults: normalized })).toEqual(normalized);
  });

  it('reads the raw snake_case wire field from a direct host adapter', () => {
    expect(readMemoryDefaults({ memory_defaults: wire })).toEqual(normalized);
  });

  it('reads as null when the set is incomplete or malformed, never as a wrong number', () => {
    expect(readMemoryDefaults(null)).toBeNull();
    expect(readMemoryDefaults({})).toBeNull();
    expect(readMemoryDefaults({ memoryDefaults: { ...normalized, recallTimeoutMs: '2500' } })).toBeNull();
    expect(readMemoryDefaults({ memoryDefaults: { ...normalized, reflectBudget: 'ultra' } })).toBeNull();
    expect(readMemoryDefaults({ memoryDefaults: { ...normalized, backend: 'sqlite' } })).toBeNull();
    const { backend: _backend, ...noBackend } = normalized;
    expect(readMemoryDefaults({ memoryDefaults: noBackend })).toBeNull();
    const { reflectTimeoutMs: _omitted, ...partial } = normalized;
    expect(readMemoryDefaults({ memoryDefaults: partial })).toBeNull();
  });

  it('reads the relevance-gating settings, which the server now resolves in this capability', () => {
    // The fixtures already include recallMinScore, recallMaxItems, recallMaxEntities.
    expect(readMemoryDefaults({ memoryDefaults: normalized })).toEqual(normalized);
  });

  it('reads the experimental hindsight backend without exposing it as a bank', () => {
    expect(
      readMemoryDefaults({ memoryDefaults: { ...normalized, backend: 'hindsight' } }),
    ).toEqual({ ...normalized, backend: 'hindsight' });
  });
});

import type { MemoryConfig } from '../../../../src/runtime/memory/memoryCapability';
import { applyMemorySettings } from '../../../../src/runtime/memory/memorySettings';

const BASE: MemoryConfig = {
  recallMaxTokens: 2048,
  recallEntityTokens: 512,
  recallTimeoutMs: 2500,
  recallQueryWindow: 5,
  recallMinScore: 0.5,
  recallMaxItems: 12,
  recallMaxEntities: 8,
  retainTimeoutMs: 10_000,
  sweepMaxPerTurn: 5,
  screen: { enabled: false, url: '', authToken: '', threshold: 0.5, timeoutMs: 1500, maxConcurrency: 8 },
  curated: { enabled: true, maxModels: 3, maxTokens: 512 },
  reflect: { enabled: true, budget: 'low', maxTokens: 512, timeoutMs: 8000 },
};

describe('applyMemorySettings', () => {
  it('returns the server defaults untouched when the bank carries no tuning', () => {
    expect(applyMemorySettings(undefined, BASE)).toBe(BASE);
    expect(applyMemorySettings({}, BASE)).toEqual(BASE);
  });

  it('overrides only the fields that were set and keeps every other default', () => {
    const merged = applyMemorySettings(
      { recall_timeout_ms: 6000, reflect_enabled: false, reflect_budget: 'mid', curated_max_models: 1 },
      BASE,
    );
    expect(merged).toEqual({
      ...BASE,
      recallTimeoutMs: 6000,
      curated: { ...BASE.curated, maxModels: 1 },
      reflect: { ...BASE.reflect, enabled: false, budget: 'mid' },
    });
  });

  it('overrides the relevance-gate fields independently', () => {
    const merged = applyMemorySettings({ recall_min_score: 0.7, recall_max_items: 20, recall_max_entities: 4 }, BASE);
    expect(merged).toEqual({
      ...BASE,
      recallMinScore: 0.7,
      recallMaxItems: 20,
      recallMaxEntities: 4,
    });
  });

  it('turns the recall screen off when screen_enabled is explicitly false, even when the server default is on', () => {
    const base: MemoryConfig = { ...BASE, screen: { ...BASE.screen, enabled: true } };
    const merged = applyMemorySettings({ screen_enabled: false }, base);
    expect(merged.screen).toEqual({ ...base.screen, enabled: false });
  });

  it('turns the recall screen on when screen_enabled is explicitly true, even when the server default is off', () => {
    const merged = applyMemorySettings({ screen_enabled: true }, BASE);
    expect(merged.screen).toEqual({ ...BASE.screen, enabled: true });
  });

  it('keeps the server default when screen_enabled is unset', () => {
    const merged = applyMemorySettings({ recall_timeout_ms: 6000 }, BASE);
    expect(merged.screen).toEqual(BASE.screen);
  });
});

import type { MemoryConfig } from '../../../../src/runtime/memory/memoryCapability';
import { withMemoryScreenOverride } from '../../../../src/runtime/memory/memorySettings';

const BASE: MemoryConfig = {
  recallMaxTokens: 2048,
  recallTimeoutMs: 2500,
  recallQueryWindow: 5,
  recallMinScore: 0.5,
  recallMaxItems: 12,
  preRecallGateEnabled: false,
  retainTimeoutMs: 10_000,
  sweepMaxPerTurn: 5,
  screen: { enabled: false, url: '', authToken: '', threshold: 0.5, timeoutMs: 1500, maxConcurrency: 8 },
  pages: { maxCount: 6, maxTokens: 1500 },
};

describe('withMemoryScreenOverride', () => {
  it('returns the server defaults untouched when no override is stored', () => {
    expect(withMemoryScreenOverride({ base: BASE, override: undefined })).toBe(BASE);
  });

  it('turns the recall screen off when the override is false, even when the server default is on', () => {
    const base: MemoryConfig = { ...BASE, screen: { ...BASE.screen, enabled: true } };
    const merged = withMemoryScreenOverride({ base, override: false });
    expect(merged).toEqual({ ...base, screen: { ...base.screen, enabled: false } });
  });

  it('turns the recall screen on when the override is true, even when the server default is off', () => {
    const merged = withMemoryScreenOverride({ base: BASE, override: true });
    expect(merged).toEqual({ ...BASE, screen: { ...BASE.screen, enabled: true } });
  });
});

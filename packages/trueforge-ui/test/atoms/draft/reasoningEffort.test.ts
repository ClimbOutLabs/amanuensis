import { describe, expect, it } from 'vitest';

import {
  hasReasoningEfforts,
  modelPatchForComposerEffort,
  modelPatchWithReasoningEffort,
  readThinkingMode,
  resolveReasoningEffort,
} from '@/atoms/draft/reasoningEffort.js';

describe('hasReasoningEfforts', () => {
  it('is false for nullish or empty', () => {
    expect(hasReasoningEfforts(undefined)).toBe(false);
    expect(hasReasoningEfforts([])).toBe(false);
  });

  it('is true when non-empty', () => {
    expect(hasReasoningEfforts(['low'])).toBe(true);
  });
});

describe('resolveReasoningEffort', () => {
  it('returns undefined when no efforts', () => {
    expect(resolveReasoningEffort(undefined, 'high')).toBeUndefined();
    expect(resolveReasoningEffort([], 'high')).toBeUndefined();
  });

  it('keeps current when still listed', () => {
    expect(resolveReasoningEffort(['low', 'high'], 'high')).toBe('high');
  });

  it('falls back to first when current missing or invalid', () => {
    expect(resolveReasoningEffort(['low', 'high'], undefined)).toBe('low');
    expect(resolveReasoningEffort(['low', 'high'], 'medium')).toBe('low');
  });

  it('defaults to the lowest non-"none" effort, skipping "none"', () => {
    expect(resolveReasoningEffort(['none', 'low', 'high'], undefined)).toBe('low');
    expect(resolveReasoningEffort(['none', 'minimal', 'low'], 'bogus')).toBe('minimal');
  });

  it('still honors an explicit "none" selection', () => {
    expect(resolveReasoningEffort(['none', 'low', 'high'], 'none')).toBe('none');
  });

  it('falls back to "none" only when it is the sole effort', () => {
    expect(resolveReasoningEffort(['none'], undefined)).toBe('none');
  });

  it('prefers "medium" as the provider default when it is offered', () => {
    expect(resolveReasoningEffort(['low', 'medium', 'high'], undefined)).toBe('medium');
    expect(resolveReasoningEffort(['xhigh', 'medium', 'low'], 'bogus')).toBe('medium');
  });

  it('clamps an effort the model no longer supports (e.g. after switching models)', () => {
    // A model whose provider supports only xhigh/medium/low must not keep a
    // "high" or "minimal" effort carried over from a different model.
    expect(resolveReasoningEffort(['xhigh', 'medium', 'low'], 'high')).toBe('medium');
    expect(resolveReasoningEffort(['xhigh', 'medium', 'low'], 'minimal')).toBe('medium');
  });
});

describe('modelPatchWithReasoningEffort', () => {
  it('sets effort and preserves other params', () => {
    expect(modelPatchWithReasoningEffort('m', { maxTokens: 100, reasoningEffort: 'high' }, ['low', 'high'])).toEqual({
      name: 'm',
      params: { maxTokens: 100, reasoningEffort: 'high' },
    });
  });

  it('falls back to first and clears effort when model has none', () => {
    expect(modelPatchWithReasoningEffort('m', { maxTokens: 100, reasoningEffort: 'high' }, ['low'])).toEqual({
      name: 'm',
      params: { maxTokens: 100, reasoningEffort: 'low' },
    });

    // `undefined` must be present so mergeAgentSpec overwrites a sticky effort.
    expect(modelPatchWithReasoningEffort('m', { maxTokens: 100, reasoningEffort: 'high' }, [])).toEqual({
      name: 'm',
      params: { maxTokens: 100, reasoningEffort: undefined },
    });

    expect(modelPatchWithReasoningEffort('m', { reasoningEffort: 'high' }, undefined)).toEqual({
      name: 'm',
      params: { reasoningEffort: undefined },
    });
  });
});

const composerEfforts = ['none', 'low', 'medium', 'high'];

describe('modelPatchForComposerEffort', () => {
  it('sets the picked effort and a fixed mode, so an automatic persona still uses the pick for this chat', () => {
    const patch = modelPatchForComposerEffort('model-a', { reasoningEffortMode: 'automatic' }, 'high', composerEfforts);

    expect(patch.params?.reasoningEffort).toBe('high');
    expect(readThinkingMode(patch.params)).toBe('fixed');
  });

  it('keeps the other params of the chat as they were', () => {
    const patch = modelPatchForComposerEffort(
      'model-a',
      { temperature: 0.2, reasoningEffortMode: 'automatic' },
      'low',
      composerEfforts,
    );

    expect(patch.params).toMatchObject({ temperature: 0.2, reasoningEffort: 'low', reasoningEffortMode: 'fixed' });
  });

  it('does not change the params it was given, so the persona stays on its own mode', () => {
    const existing = { reasoningEffortMode: 'automatic' as const, reasoningEffort: 'medium' };

    modelPatchForComposerEffort('model-a', existing, 'high', composerEfforts);

    expect(existing).toEqual({ reasoningEffortMode: 'automatic', reasoningEffort: 'medium' });
  });
});

describe('readThinkingMode', () => {
  it('reads an absent mode as fixed, so a persona keeps its stored effort on every step', () => {
    expect(readThinkingMode({ reasoningEffort: 'low' })).toBe('fixed');
    expect(readThinkingMode(undefined)).toBe('fixed');
    expect(readThinkingMode({ reasoningEffortMode: 'automatic' })).toBe('automatic');
  });
});

import {
  CAPPED_STEP_REASONING_ALLOWANCE_TOKENS,
  FINAL_ANSWER_OUTPUT_TOKENS,
  nearestSupportedEffort,
  readReasoningEffortMode,
  readStoredReasoningEffort,
  resolveStepReasoningEffort,
  stepMaxOutputTokens,
} from '../../../src/core/llm/reasoningEffortPolicy';

describe('nearestSupportedEffort', () => {
  it('keeps a supported target as is', () => {
    expect(nearestSupportedEffort({ target: 'medium', supported: ['low', 'medium', 'high'] })).toBe('medium');
  });

  it('moves to the closest supported level', () => {
    expect(nearestSupportedEffort({ target: 'high', supported: ['none', 'low', 'medium'] })).toBe('medium');
    expect(nearestSupportedEffort({ target: 'low', supported: ['medium', 'xhigh'] })).toBe('medium');
  });

  it('breaks ties toward the lower effort, which costs fewer tokens', () => {
    // medium is one step from both low and high.
    expect(nearestSupportedEffort({ target: 'medium', supported: ['low', 'high'] })).toBe('low');
  });

  it('ignores efforts the harness does not know', () => {
    expect(nearestSupportedEffort({ target: 'high', supported: ['turbo', 'low'] })).toBe('low');
    expect(nearestSupportedEffort({ target: 'high', supported: ['turbo'] })).toBeUndefined();
  });

  it('returns undefined for an unknown target', () => {
    expect(nearestSupportedEffort({ target: 'turbo', supported: ['low'] })).toBeUndefined();
  });
});

describe('resolveStepReasoningEffort', () => {
  const supported = ['none', 'low', 'medium', 'high'];

  it('automatic mode maps each step kind to its level', () => {
    const effortFor = (stepKind: Parameters<typeof resolveStepReasoningEffort>[0]['stepKind']) =>
      resolveStepReasoningEffort({ stepKind, mode: 'automatic', storedEffort: 'low', supported });
    expect(effortFor('first')).toBe('high');
    expect(effortFor('continuation')).toBe('low');
    expect(effortFor('final_answer')).toBe('medium');
    expect(effortFor('sub_agent')).toBe('low');
  });

  it('maps onto the nearest level when the model lacks the target', () => {
    expect(
      resolveStepReasoningEffort({
        stepKind: 'first',
        mode: 'automatic',
        storedEffort: undefined,
        supported: ['low', 'medium'],
      }),
    ).toBe('medium');
  });

  it('sends no effort for a model that advertises none', () => {
    expect(
      resolveStepReasoningEffort({ stepKind: 'first', mode: 'automatic', storedEffort: 'high', supported: undefined }),
    ).toBeUndefined();
    expect(
      resolveStepReasoningEffort({ stepKind: 'first', mode: 'fixed', storedEffort: 'high', supported: [] }),
    ).toBeUndefined();
  });

  it('fixed mode sends the stored effort on every step, moved onto a supported level', () => {
    for (const stepKind of ['first', 'continuation', 'final_answer', 'sub_agent'] as const) {
      expect(resolveStepReasoningEffort({ stepKind, mode: 'fixed', storedEffort: 'high', supported })).toBe('high');
    }
    expect(
      resolveStepReasoningEffort({
        stepKind: 'first',
        mode: 'fixed',
        storedEffort: 'xhigh',
        supported: ['low', 'medium'],
      }),
    ).toBe('medium');
  });

  it('fixed mode with no stored effort sends no effort', () => {
    expect(
      resolveStepReasoningEffort({ stepKind: 'first', mode: 'fixed', storedEffort: undefined, supported }),
    ).toBeUndefined();
  });
});

describe('stepMaxOutputTokens', () => {
  it('caps a final answer that offers no tools, with the reasoning allowance when an effort is sent', () => {
    expect(
      stepMaxOutputTokens({
        stepKind: 'final_answer',
        offersTools: false,
        configured: undefined,
        reasoningEffort: undefined,
      }),
    ).toBe(FINAL_ANSWER_OUTPUT_TOKENS);
    expect(
      stepMaxOutputTokens({
        stepKind: 'final_answer',
        offersTools: false,
        configured: undefined,
        reasoningEffort: 'medium',
      }),
    ).toBe(FINAL_ANSWER_OUTPUT_TOKENS + CAPPED_STEP_REASONING_ALLOWANCE_TOKENS);
  });

  it('never raises a configured limit above the final-answer cap', () => {
    expect(
      stepMaxOutputTokens({
        stepKind: 'final_answer',
        offersTools: false,
        configured: 500,
        reasoningEffort: undefined,
      }),
    ).toBe(500);
    expect(
      stepMaxOutputTokens({
        stepKind: 'final_answer',
        offersTools: false,
        configured: 1_000_000,
        reasoningEffort: undefined,
      }),
    ).toBe(FINAL_ANSWER_OUTPUT_TOKENS);
  });

  it('never caps a final-answer step that still offers tools, since a tool call may be written there', () => {
    expect(
      stepMaxOutputTokens({
        stepKind: 'final_answer',
        offersTools: true,
        configured: undefined,
        reasoningEffort: 'medium',
      }),
    ).toBeUndefined();
    expect(
      stepMaxOutputTokens({
        stepKind: 'final_answer',
        offersTools: true,
        configured: 16_000,
        reasoningEffort: 'medium',
      }),
    ).toBe(16_000);
  });

  it('keeps tool-capable continuation, first and sub-agent steps at the configured limit', () => {
    for (const stepKind of ['continuation', 'first', 'sub_agent'] as const) {
      expect(stepMaxOutputTokens({ stepKind, offersTools: true, configured: 16_000, reasoningEffort: 'high' })).toBe(
        16_000,
      );
      expect(
        stepMaxOutputTokens({ stepKind, offersTools: true, configured: undefined, reasoningEffort: 'high' }),
      ).toBeUndefined();
    }
  });
});

describe('persisted reasoning fields', () => {
  it('reads the mode, defaulting to automatic for anything but fixed', () => {
    expect(readReasoningEffortMode(undefined)).toBe('automatic');
    expect(readReasoningEffortMode({})).toBe('automatic');
    expect(readReasoningEffortMode({ reasoning_effort_mode: 'automatic' })).toBe('automatic');
    expect(readReasoningEffortMode({ reasoning_effort_mode: 'fixed' })).toBe('fixed');
    expect(readReasoningEffortMode({ reasoning_effort_mode: 'sometimes' })).toBe('automatic');
  });

  it('reads the stored effort only when it is a string', () => {
    expect(readStoredReasoningEffort({ reasoning_effort: 'high' })).toBe('high');
    expect(readStoredReasoningEffort({ reasoning_effort: 3 })).toBeUndefined();
    expect(readStoredReasoningEffort(undefined)).toBeUndefined();
  });
});

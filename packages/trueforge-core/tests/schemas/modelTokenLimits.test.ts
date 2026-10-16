import { TOKEN_BUDGET_SAFETY_MARGIN } from '../../src/core/capabilities/builtins/tokenBudgetConstants';
import { getModelOutputExceedsContextError } from '../../src/schemas/modelTokenLimits';

const CONTEXT = 128_000;

describe('getModelOutputExceedsContextError', () => {
  it('accepts a max output that leaves room for the safety margin', () => {
    expect(
      getModelOutputExceedsContextError({
        context_length: CONTEXT,
        max_output_tokens: CONTEXT - TOKEN_BUDGET_SAFETY_MARGIN - 1,
      }),
    ).toBeNull();
    expect(getModelOutputExceedsContextError({ context_length: CONTEXT, max_output_tokens: 4096 })).toBeNull();
  });

  it('rejects a max output that reaches the context length once the margin is added', () => {
    const expected = 'Max output tokens must be less than the context length (128,000) minus a small reserve.';
    expect(
      getModelOutputExceedsContextError({
        context_length: CONTEXT,
        max_output_tokens: CONTEXT - TOKEN_BUDGET_SAFETY_MARGIN,
      }),
    ).toBe(expected);
    expect(getModelOutputExceedsContextError({ context_length: CONTEXT, max_output_tokens: CONTEXT })).toBe(expected);
    expect(getModelOutputExceedsContextError({ context_length: CONTEXT, max_output_tokens: CONTEXT * 2 })).toBe(
      expected,
    );
  });

  it('only checks the combination, so a single known limit is accepted', () => {
    expect(getModelOutputExceedsContextError({ context_length: CONTEXT, max_output_tokens: undefined })).toBeNull();
    expect(getModelOutputExceedsContextError({ context_length: null, max_output_tokens: CONTEXT })).toBeNull();
    expect(getModelOutputExceedsContextError({ context_length: undefined, max_output_tokens: undefined })).toBeNull();
  });
});

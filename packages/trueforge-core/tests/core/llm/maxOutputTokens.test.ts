import { resolveMaxOutputTokens } from '../../../src/core/llm/maxOutputTokens';
import type { ModelParams } from '../../../src/core/runtime/AgentDefinition';

describe('resolveMaxOutputTokens', () => {
  it('returns max_completion_tokens when set', () => {
    expect(resolveMaxOutputTokens({ max_completion_tokens: 512 })).toBe(512);
  });

  it('falls back to max_tokens when max_completion_tokens is absent', () => {
    const body = JSON.parse('{"max_tokens":256}');
    expect(resolveMaxOutputTokens(body)).toBe(256);
  });

  it('prefers max_completion_tokens over max_tokens', () => {
    const body = JSON.parse('{"max_completion_tokens":512,"max_tokens":256}');
    expect(resolveMaxOutputTokens(body)).toBe(512);
  });

  it('returns undefined when neither is set', () => {
    expect(resolveMaxOutputTokens({})).toBeUndefined();
  });

  it('returns undefined for non-numeric values', () => {
    const body = JSON.parse('{"max_completion_tokens":"not-a-number"}');
    expect(resolveMaxOutputTokens(body)).toBeUndefined();
  });

  it('returns undefined for non-finite or negative values and for missing params', () => {
    expect(resolveMaxOutputTokens({ max_tokens: Number.NaN })).toBeUndefined();
    expect(resolveMaxOutputTokens({ max_tokens: Number.POSITIVE_INFINITY })).toBeUndefined();
    expect(resolveMaxOutputTokens({ max_tokens: -1 })).toBeUndefined();
    expect(resolveMaxOutputTokens(undefined)).toBeUndefined();
  });

  it('accepts model params records', () => {
    const modelParams: ModelParams = { temperature: 0, max_tokens: 64 };
    expect(resolveMaxOutputTokens(modelParams)).toBe(64);
  });
});

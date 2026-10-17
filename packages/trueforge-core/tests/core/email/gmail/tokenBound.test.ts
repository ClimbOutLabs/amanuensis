import { estimateTokens, snippetOf, truncateToTokens } from '../../../../src/core/email/gmail/tokenBound';

describe('estimateTokens', () => {
  it('counts Latin text at about four characters a token', () => {
    expect(estimateTokens('a'.repeat(400))).toBe(100);
  });

  it('counts other scripts at about a token a character, so they cannot overshoot the bound', () => {
    expect(estimateTokens('日本語'.repeat(100))).toBe(300);
    expect(estimateTokens('مرحبا'.repeat(100))).toBe(500);
  });
});

describe('truncateToTokens', () => {
  it('keeps text that fits', () => {
    expect(truncateToTokens({ text: 'hello', maxTokens: 10 })).toEqual({ text: 'hello', truncated: false });
  });

  it('cuts Latin text to the budget', () => {
    const cut = truncateToTokens({ text: 'a'.repeat(1000), maxTokens: 100 });
    expect(cut.truncated).toBe(true);
    expect(estimateTokens(cut.text)).toBeLessThanOrEqual(100);
  });

  it('cuts Japanese text to the same budget, not four times past it', () => {
    const cut = truncateToTokens({ text: '日本語'.repeat(1000), maxTokens: 100 });
    expect(cut.truncated).toBe(true);
    expect(estimateTokens(cut.text)).toBeLessThanOrEqual(100);
    expect(Array.from(cut.text).length).toBe(100);
  });

  it('never splits a code point', () => {
    const cut = truncateToTokens({ text: '😀'.repeat(50), maxTokens: 10 });
    expect(cut.text).toBe('😀'.repeat(10));
  });
});

describe('snippetOf', () => {
  it('flattens whitespace and caps the length', () => {
    expect(snippetOf('a\n\n  b')).toBe('a b');
    expect(snippetOf('x'.repeat(300))).toHaveLength(203);
  });
});

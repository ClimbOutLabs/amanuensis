import { chunkText } from '../../../src/personaKnowledge/documentChunking';

describe('chunkText', () => {
  it('keeps short text in a single chunk', () => {
    const { chunks, truncated } = chunkText('Hello world. This is a short note.');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain('Hello world');
    expect(truncated).toBe(false);
  });

  it('splits long text into bounded chunks on sentence boundaries', () => {
    const sentence = 'The solo project sold for twenty million dollars after years of work. ';
    const text = sentence.repeat(200);
    // Overlap disabled here: with overlap enabled, non-first chunks deliberately
    // start with trailing context from the previous chunk, not a sentence start.
    const { chunks } = chunkText(text, { chunkChars: 1200, overlapChars: 0 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(1400);
    }
    // No chunk should start mid-sentence: every chunk after the first begins
    // with a capital letter (the sentence splitter's contract).
    for (const chunk of chunks.slice(1)) {
      expect(chunk[0]).toMatch(/[A-Z0-9"'“(\[]/);
    }
  });

  it('hard-cuts a single over-long sentence so chunks stay bounded', () => {
    const { chunks } = chunkText('a'.repeat(5000), { chunkChars: 1200 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(1400);
    }
  });

  it('flags truncation when the input exceeds the character cap', () => {
    const { chunks, truncated } = chunkText('word '.repeat(10_000), { maxChars: 1000 });
    expect(truncated).toBe(true);
    expect(chunks.join(' ').length).toBeLessThanOrEqual(1200);
  });

  it('returns no chunks for blank input', () => {
    expect(chunkText('   \n  ').chunks).toHaveLength(0);
  });
});

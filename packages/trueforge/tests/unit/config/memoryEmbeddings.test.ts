import { parsePositiveInt } from '../../../src/config';
import { defaultEmbeddingModelDir } from '../../../src/runtime/memory/embeddingRetrieval';

describe('MEMORY_EMBEDDINGS_BACKFILL_BATCH_SIZE env parsing', () => {
  const parse = (raw: string | undefined) =>
    parsePositiveInt({ envKey: 'MEMORY_EMBEDDINGS_BACKFILL_BATCH_SIZE', raw, defaultValue: 8 });

  it('defaults to 8 batches when unset', () => {
    expect(parse(undefined)).toBe(8);
  });

  it('accepts a positive batch size', () => {
    expect(parse('16')).toBe(16);
  });

  it('rejects zero, negative, and non-numeric values', () => {
    expect(() => parse('0')).toThrow('must be an integer of at least 1');
    expect(() => parse('-3')).toThrow('must be an integer of at least 1');
    expect(() => parse('lots')).toThrow();
  });
});

describe('defaultEmbeddingModelDir', () => {
  it('keeps the model cache inside the markdown dir so it rides the same persistent volume', () => {
    expect(defaultEmbeddingModelDir('/data/memory')).toBe('/data/memory/.embedding-model');
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { readMemoryBackend } from '@/plugins/trueforge-agent-server-adapter/lists.js';

describe('readMemoryBackend', () => {
  it('reads the raw snake_case payload a direct host adapter exposes', () => {
    assert.equal(readMemoryBackend({ memory_defaults: { backend: 'markdown' } }), 'markdown');
    assert.equal(readMemoryBackend({ memory_defaults: { backend: 'hindsight' } }), 'hindsight');
  });

  it('rejects malformed input rather than guessing', () => {
    assert.equal(readMemoryBackend(null), undefined);
    assert.equal(readMemoryBackend('markdown'), undefined);
    assert.equal(readMemoryBackend({}), undefined);
    assert.equal(readMemoryBackend({ memoryDefaults: null }), undefined);
    assert.equal(readMemoryBackend({ memoryDefaults: { backend: 42 } }), undefined);
    assert.equal(readMemoryBackend({ memoryDefaults: {} }), undefined);
    assert.equal(readMemoryBackend({ memoryDefaults: { backend: 'something-new' } }), undefined);
  });
});

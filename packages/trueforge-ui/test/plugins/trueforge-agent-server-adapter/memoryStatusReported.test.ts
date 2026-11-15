import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { memoryStatusReported } from '@/plugins/trueforge-agent-server-adapter/lists.js';

describe('memoryStatusReported', () => {
  it('reads the camelCase payload the SDK returns and the raw snake_case one a direct host exposes', () => {
    assert.equal(memoryStatusReported({ memoryDefaults: { markdownDir: '/data/memory' } }), true);
    assert.equal(memoryStatusReported({ memory_defaults: { markdown_dir: '/data/memory' } }), true);
  });

  it('rejects malformed input rather than guessing', () => {
    assert.equal(memoryStatusReported(null), false);
    assert.equal(memoryStatusReported('markdown'), false);
    assert.equal(memoryStatusReported({}), false);
    assert.equal(memoryStatusReported({ memoryDefaults: null }), false);
    assert.equal(memoryStatusReported({ memoryDefaults: 42 }), false);
  });
});

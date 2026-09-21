import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import type { TrueForge } from '@truefoundry/trueforge-sdk';

import {
  getMemoryBankStatus,
  readMemoryBackend,
} from '@/plugins/trueforge-agent-server-adapter/lists.js';

/** Only `server.getCapabilities` is exercised; the rest of the client stays unimplemented. */
function fakeClient(capabilitiesData: unknown): TrueForge {
  return {
    server: {
      getCapabilities: async () => ({ data: capabilitiesData }),
    },
  } as unknown as TrueForge;
}

describe('getMemoryBankStatus', () => {
  it('reports Markdown memory as on, never asking for a bank connection', async () => {
    const status = await getMemoryBankStatus(fakeClient({ memoryDefaults: { backend: 'markdown' } }));
    assert.deepEqual(status, { name: 'Markdown (local files)', connected: true });
  });

  it('reports the experimental Hindsight backend as on with no bank UI', async () => {
    const status = await getMemoryBankStatus(fakeClient({ memoryDefaults: { backend: 'hindsight' } }));
    assert.deepEqual(status, { name: 'Hindsight (experimental)', connected: true });
  });

  it('reports null when the server does not name a memory backend', async () => {
    assert.equal(await getMemoryBankStatus(fakeClient({})), null);
    assert.equal(
      await getMemoryBankStatus(fakeClient({ memoryDefaults: { backend: 'something-new' } })),
      null,
    );
  });
});

describe('readMemoryBackend', () => {
  it('reads the raw snake_case payload a direct host adapter exposes', () => {
    assert.equal(readMemoryBackend({ memory_defaults: { backend: 'markdown' } }), 'markdown');
    assert.equal(readMemoryBackend({ memory_defaults: { backend: 'hindsight' } }), 'hindsight');
  });

  it('rejects malformed input rather than guessing', () => {
    assert.equal(readMemoryBackend(null), undefined);
    assert.equal(readMemoryBackend('markdown'), undefined);
    assert.equal(readMemoryBackend({ memoryDefaults: null }), undefined);
    assert.equal(readMemoryBackend({ memoryDefaults: { backend: 42 } }), undefined);
    assert.equal(readMemoryBackend({ memoryDefaults: {} }), undefined);
  });
});

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createMemoryClient } from '../../../../src/runtime/memory/createMemoryClient';
import type { VaultScope } from '../../../../src/runtime/memory/markdownMemoryFiles';
import type { MemoryClient } from '../../../../src/runtime/memory/memoryClient';

let markdownDir = '';

beforeEach(async () => {
  markdownDir = await mkdtemp(path.join(tmpdir(), 'create-memory-client-'));
});

afterEach(async () => {
  await rm(markdownDir, { recursive: true, force: true });
});

function markdownClient(vaultScope: VaultScope | undefined): MemoryClient {
  const client = createMemoryClient({
    backend: 'markdown',
    markdownDir,
    namespace: 'tenant-1',
    vaultScope,
    hindsight: undefined,
  });
  if (client === undefined) {
    throw new Error('expected a markdown memory client');
  }
  return client;
}

async function retainOne(client: MemoryClient, content: string): Promise<void> {
  const outcome = await client.retain({
    items: [{ content, timestamp: '2026-09-26T10:00:00.000Z', document_id: 'doc-1' }],
    operationId: 'op-1',
    timeoutMs: 5000,
  });
  expect(outcome).toEqual({ ok: true });
}

describe('createMemoryClient vault scope', () => {
  it('retains into the persona vault when a persona is active', async () => {
    await retainOne(
      markdownClient({ personaName: 'Alpha', personaId: 'persona-alpha-id' }),
      'Alpha prefers oolong tea',
    );

    const log = await readFile(path.join(markdownDir, 'tenant-1__persona_Alpha', 'memory', '2026-09-26.md'), 'utf8');
    expect(log).toContain('oolong tea');
  });

  it('retains into the shared vault when no persona is active', async () => {
    await retainOne(markdownClient(undefined), 'The household recycles on Thursdays');

    const log = await readFile(path.join(markdownDir, 'tenant-1', 'memory', '2026-09-26.md'), 'utf8');
    expect(log).toContain('recycles on Thursdays');
  });
});

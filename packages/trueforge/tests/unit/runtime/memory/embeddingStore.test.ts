import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL_REVISION,
} from '../../../../src/runtime/memory/embeddingModel';
import { EmbeddingStore, hashEntryText } from '../../../../src/runtime/memory/embeddingStore';

function vector(seed: number): number[] {
  const values = new Array(EMBEDDING_DIMENSIONS).fill(0);
  values[seed % EMBEDDING_DIMENSIONS] = 1;
  return values;
}

async function makeNamespaceDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'embstore-'));
  const nsDir = path.join(dir, 'tenant-1');
  await mkdir(nsDir, { recursive: true });
  return nsDir;
}

async function cleanup(nsDir: string): Promise<void> {
  await rm(path.dirname(nsDir), { recursive: true, force: true });
}

describe('EmbeddingStore', () => {
  it('round-trips entries through save/load', async () => {
    const nsDir = await makeNamespaceDir();
    try {
      const store = await EmbeddingStore.load({ namespaceDir: nsDir });
      store.set({ id: 'id-1', text: 'hello world', vector: vector(3) });
      store.set({ id: 'id-2', text: 'hola mundo', vector: vector(7) });
      store.markBackfilled();
      await store.save();

      const reloaded = await EmbeddingStore.load({ namespaceDir: nsDir });
      expect(reloaded.size).toBe(2);
      expect(reloaded.isBackfilled).toBe(true);
      const entry = reloaded.get('id-1');
      expect(entry?.hash).toBe(hashEntryText('hello world'));
      expect(entry?.vector.length).toBe(EMBEDDING_DIMENSIONS);
      // The cache must never persist memory text: only id, hash, and vector.
      const persisted = JSON.parse(
        await readFile(path.join(nsDir, '.embeddings.json'), 'utf8'),
      ) as { entries: Record<string, Record<string, unknown>> };
      expect(persisted.entries['id-1']).not.toHaveProperty('text');
      expect(JSON.stringify(persisted)).not.toContain('hello world');
      // Owner-only permissions, like the Markdown files it indexes.
      const fileStat = await stat(path.join(nsDir, '.embeddings.json'));
      expect(fileStat.mode & 0o777).toBe(0o600);
      expect(entry?.vector.length).toBe(EMBEDDING_DIMENSIONS);
      expect(entry?.vector[3]).toBe(1);
    } finally {
      await cleanup(nsDir);
    }
  });

  it('starts empty on corrupt files or a model-pin mismatch', async () => {
    const nsDir = await makeNamespaceDir();
    try {
      await writeFile(path.join(nsDir, '.embeddings.json'), 'not json{{{', 'utf8');
      const corrupt = await EmbeddingStore.load({ namespaceDir: nsDir });
      expect(corrupt.size).toBe(0);

      const store = await EmbeddingStore.load({ namespaceDir: nsDir });
      store.set({ id: 'id-1', text: 'x', vector: vector(1) });
      await store.save();
      const raw = await readFile(path.join(nsDir, '.embeddings.json'), 'utf8');
      await writeFile(
        path.join(nsDir, '.embeddings.json'),
        raw.replace(EMBEDDING_MODEL_REVISION, '0'.repeat(40)),
        'utf8',
      );
      const invalidated = await EmbeddingStore.load({ namespaceDir: nsDir });
      expect(invalidated.size).toBe(0);
      expect(invalidated.isBackfilled).toBe(false);
    } finally {
      await cleanup(nsDir);
    }
  });

  it('reconcile drops deleted entries and reports whether anything changed', async () => {
    const nsDir = await makeNamespaceDir();
    try {
      const store = await EmbeddingStore.load({ namespaceDir: nsDir });
      store.set({ id: 'keep', text: 'a', vector: vector(1) });
      store.set({ id: 'drop', text: 'b', vector: vector(2) });
      expect(store.reconcile(new Set(['keep']))).toBe(true);
      expect(store.reconcile(new Set(['keep']))).toBe(false);
      expect(store.get('drop')).toBeUndefined();
      await store.save();
      const reloaded = await EmbeddingStore.load({ namespaceDir: nsDir });
      expect(reloaded.get('drop')).toBeUndefined();
      expect(reloaded.get('keep')?.hash).toBe(hashEntryText('a'));
    } finally {
      await cleanup(nsDir);
    }
  });

  it('ignores wrong-dimension vectors', async () => {
    const nsDir = await makeNamespaceDir();
    try {
      const store = await EmbeddingStore.load({ namespaceDir: nsDir });
      store.set({ id: 'bad', text: 'x', vector: [1, 2, 3] });
      expect(store.size).toBe(0);
    } finally {
      await cleanup(nsDir);
    }
  });
});

/**
 * Persistent per-namespace embedding cache (`{namespaceDir}/.embeddings.json`).
 * Stores only ids, content hashes, and vectors — never memory text. Hit text
 * always resolves from the live Markdown scan, so deleted memories leave no
 * plaintext in the cache. Writes are atomic (tmp + rename); the cache is
 * invalidated wholesale when the model pin or format version changes, and
 * `reconcile()` drops embeddings of deleted memories so they do not linger.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL_ID, EMBEDDING_MODEL_REVISION } from './embeddingModel';

const STORE_FILENAME = '.embeddings.json';
const STORE_TMP_SUFFIX = '.tmp';
const STORE_VERSION = 2;

export function hashEntryText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function encodeVector(vector: ArrayLike<number>): string {
  const floats = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i++) {
    const component = vector[i];
    floats[i] = typeof component === 'number' ? component : 0;
  }
  return Buffer.from(floats.buffer).toString('base64');
}

function decodeVector(encoded: string): Float32Array | undefined {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(encoded, 'base64');
  } catch {
    return undefined;
  }
  if (bytes.length !== EMBEDDING_DIMENSIONS * 4) {
    return undefined;
  }
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
}

interface StoredEntryFile {
  hash: string;
  vector: string;
}

interface StoreFile {
  version: number;
  modelId: string;
  modelRevision: string;
  backfilled: boolean;
  entries: Record<string, StoredEntryFile>;
}

function isStoredEntryFile(value: unknown): value is StoredEntryFile {
  if (typeof value !== 'object' || value === null || !('hash' in value && 'vector' in value)) {
    return false;
  }
  return typeof value.hash === 'string' && typeof value.vector === 'string';
}

function isStoreFile(value: unknown): value is StoreFile {
  if (
    typeof value !== 'object' ||
    value === null ||
    !(
      'version' in value &&
      'modelId' in value &&
      'modelRevision' in value &&
      'backfilled' in value &&
      'entries' in value
    )
  ) {
    return false;
  }
  if (
    value.version !== STORE_VERSION ||
    typeof value.modelId !== 'string' ||
    typeof value.modelRevision !== 'string' ||
    typeof value.backfilled !== 'boolean' ||
    typeof value.entries !== 'object' ||
    value.entries === null
  ) {
    return false;
  }
  return Object.values(value.entries).every(isStoredEntryFile);
}

export interface StoredEmbedding {
  hash: string;
  vector: Float32Array;
}

export class EmbeddingStore {
  private readonly entries = new Map<string, StoredEmbedding>();
  private backfilled = false;

  private constructor(private readonly filePath: string) {}

  /** Loads the cache; any corruption or model-pin mismatch starts empty. */
  static async load(options: { namespaceDir: string }): Promise<EmbeddingStore> {
    const store = new EmbeddingStore(path.join(options.namespaceDir, STORE_FILENAME));
    await store.read();
    return store;
  }

  get size(): number {
    return this.entries.size;
  }

  get isBackfilled(): boolean {
    return this.backfilled;
  }

  markBackfilled(): void {
    this.backfilled = true;
  }

  get(id: string): StoredEmbedding | undefined {
    return this.entries.get(id);
  }

  ids(): string[] {
    return [...this.entries.keys()];
  }

  set(entry: { id: string; text: string; vector: ArrayLike<number> }): void {
    if (entry.vector.length !== EMBEDDING_DIMENSIONS) {
      return;
    }
    const encoded = encodeVector(entry.vector);
    const decoded = decodeVector(encoded);
    if (decoded === undefined) {
      return;
    }
    // The text is hashed for change detection but not stored: hit text always
    // resolves from the live Markdown scan, so deleted memories leave no
    // plaintext behind in the cache.
    this.entries.set(entry.id, { hash: hashEntryText(entry.text), vector: decoded });
  }

  /**
   * Drops every id not in the live set (deleted files/entries). Returns true
   * when anything was removed so the caller can persist.
   */
  reconcile(liveIds: Set<string>): boolean {
    let removed = false;
    for (const id of this.entries.keys()) {
      if (!liveIds.has(id)) {
        this.entries.delete(id);
        removed = true;
      }
    }
    return removed;
  }

  async save(): Promise<void> {
    const entries: Record<string, StoredEntryFile> = {};
    for (const [id, entry] of this.entries) {
      entries[id] = { hash: entry.hash, vector: encodeVector(entry.vector) };
    }
    const file: StoreFile = {
      version: STORE_VERSION,
      modelId: EMBEDDING_MODEL_ID,
      modelRevision: EMBEDDING_MODEL_REVISION,
      backfilled: this.backfilled,
      entries,
    };
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}${STORE_TMP_SUFFIX}`;
    // Owner-only permissions, like the Markdown files it indexes.
    await writeFile(tmpPath, JSON.stringify(file), { encoding: 'utf8', mode: 0o600 });
    await rename(tmpPath, this.filePath);
  }

  private async read(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (!isStoreFile(parsed)) {
      return;
    }
    // A model change invalidates every cached vector.
    if (parsed.modelId !== EMBEDDING_MODEL_ID || parsed.modelRevision !== EMBEDDING_MODEL_REVISION) {
      return;
    }
    for (const [id, entry] of Object.entries(parsed.entries)) {
      const vector = decodeVector(entry.vector);
      if (vector === undefined) {
        continue;
      }
      this.entries.set(id, { hash: entry.hash, vector });
    }
    this.backfilled = parsed.backfilled;
  }
}

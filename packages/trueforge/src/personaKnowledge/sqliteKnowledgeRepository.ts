import { z } from '@hono/zod-openapi';
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import * as sqliteVec from 'sqlite-vec';
import { ulid } from 'ulid';

import type { KnowledgeDocumentStatus } from '../schemas/personaKnowledge';
import { PersonaKnowledgeDocumentSchema } from '../schemas/personaKnowledge';
import type {
  IndexedKnowledgeChunk,
  KnowledgeDocumentChunk,
  KnowledgeDocumentRecord,
  KnowledgeSearchHit,
  NewKnowledgeDocument,
  PersonaKnowledgeRepository,
} from './knowledgeRepository';

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS knowledge_documents (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    title_explicit INTEGER NOT NULL DEFAULT 0,
    source_kind TEXT NOT NULL,
    source_label TEXT NOT NULL,
    source_url TEXT,
    status TEXT NOT NULL,
    status_message TEXT,
    chunk_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS knowledge_chunks (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL,
    text TEXT NOT NULL,
    embedding BLOB NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS knowledge_chunks_document_id_idx ON knowledge_chunks(document_id)`,
];

// better-sqlite3 returns `unknown` for row reads; the zod schemas are the
// contract that turns a row into a typed record instead of an assertion.
const CountRowSchema = z.object({ count: z.number() });
const UsedBytesRowSchema = z.object({ bytes: z.number() });

const ChunkRowSchema = z.object({ chunk_index: z.number(), text: z.string() });

/**
 * Document rows as SQLite stores them: `title_explicit` is an INTEGER flag.
 * Parsed once at the boundary and converted to the boolean the record (and
 * the wire schema) carries.
 */
const KnowledgeDocumentRowSchema = PersonaKnowledgeDocumentSchema.extend({
  title_explicit: z.number().int().min(0).max(1),
});

function toDocumentRecord(row: unknown): KnowledgeDocumentRecord {
  const parsed = KnowledgeDocumentRowSchema.parse(row);
  return { ...parsed, title_explicit: parsed.title_explicit === 1 };
}

const VecMatchRowSchema = z.object({ chunk_id: z.string(), distance: z.number() });

const ChunkJoinRowSchema = z.object({
  chunk_id: z.string(),
  document_id: z.string(),
  chunk_index: z.number(),
  text: z.string(),
  title: z.string(),
  source_label: z.string(),
  source_url: z.string().nullable(),
});

const BruteForceRowSchema = ChunkJoinRowSchema.extend({
  embedding: z.custom<Uint8Array>(
    (value): value is Uint8Array => value instanceof Uint8Array,
    'embedding must be bytes',
  ),
});

const RebuildRowSchema = z.object({
  id: z.string(),
  embedding: z.custom<Uint8Array>(
    (value): value is Uint8Array => value instanceof Uint8Array,
    'embedding must be bytes',
  ),
});

function embeddingToBuffer(embedding: Float32Array): Buffer {
  return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}

function bufferToEmbedding(bytes: Uint8Array, dimensions: number): Float32Array {
  if (bytes.byteLength !== dimensions * 4) {
    throw new Error(`Stored embedding has ${String(bytes.byteLength)} bytes; expected ${String(dimensions * 4)}.`);
  }
  // Buffers from the driver may sit at a non-float-aligned offset inside a
  // pooled ArrayBuffer; copy to a fresh aligned buffer before viewing.
  const aligned = new Uint8Array(bytes.byteLength);
  aligned.set(bytes);
  return new Float32Array(aligned.buffer);
}

function cosineDistance(input: { a: Float32Array; b: Float32Array }): number {
  const { a, b } = input;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) {
    return 1;
  }
  return 1 - dot / Math.sqrt(normA * normB);
}

/**
 * SQLite-backed knowledge repository. Vectors live in a `vec0` virtual table
 * for indexed KNN; the raw embedding blob is also kept on each chunk row so a
 * failed extension load can fall back to brute-force cosine over the same
 * file instead of losing the library.
 *
 * Exported (beyond the factory below) so tests can construct the
 * brute-force path directly with `vecAvailable: false`.
 */
export class SqlitePersonaKnowledgeRepository implements PersonaKnowledgeRepository {
  readonly #db: Database.Database;
  readonly #dimensions: number;
  readonly #vecAvailable: boolean;
  readonly #release: (() => void) | undefined;

  constructor(input: { db: Database.Database; dimensions: number; vecAvailable: boolean; release?: () => void }) {
    this.#db = input.db;
    this.#dimensions = input.dimensions;
    this.#vecAvailable = input.vecAvailable;
    this.#release = input.release;
  }

  listDocuments(): KnowledgeDocumentRecord[] {
    const rows = this.#db.prepare('SELECT * FROM knowledge_documents ORDER BY created_at DESC, id DESC').all();
    return rows.map(toDocumentRecord);
  }

  getDocument(input: { documentId: string }): KnowledgeDocumentRecord | undefined {
    const row = this.#db.prepare('SELECT * FROM knowledge_documents WHERE id = ?').get(input.documentId);
    return row === undefined ? undefined : toDocumentRecord(row);
  }

  listDocumentChunks(input: { documentId: string }): KnowledgeDocumentChunk[] {
    const rows = this.#db
      .prepare('SELECT chunk_index, text FROM knowledge_chunks WHERE document_id = ? ORDER BY chunk_index ASC')
      .all(input.documentId);
    return rows.map(row => {
      const parsed = ChunkRowSchema.parse(row);
      return { chunkIndex: parsed.chunk_index, text: parsed.text };
    });
  }

  createDocument(input: NewKnowledgeDocument): KnowledgeDocumentRecord {
    const now = new Date().toISOString();
    const record: KnowledgeDocumentRecord = {
      id: ulid(),
      title: input.title,
      title_explicit: input.titleExplicit,
      source_kind: input.source_kind,
      source_label: input.source_label,
      source_url: input.source_url,
      status: 'pending',
      status_message: null,
      chunk_count: 0,
      created_at: now,
      updated_at: now,
    };
    this.#db
      .prepare(
        `INSERT INTO knowledge_documents
           (id, title, title_explicit, source_kind, source_label, source_url, status, status_message, chunk_count, created_at, updated_at)
         VALUES (@id, @title, @title_explicit, @source_kind, @source_label, @source_url, @status, @status_message, @chunk_count, @created_at, @updated_at)`,
      )
      .run({ ...record, title_explicit: record.title_explicit ? 1 : 0 });
    return record;
  }

  updateDocumentStatus(input: {
    documentId: string;
    status: KnowledgeDocumentStatus;
    statusMessage?: string | null;
  }): void {
    this.#db
      .prepare(
        `UPDATE knowledge_documents
         SET status = @status, status_message = @statusMessage, updated_at = @updatedAt
         WHERE id = @documentId`,
      )
      .run({
        documentId: input.documentId,
        status: input.status,
        statusMessage: input.statusMessage ?? null,
        updatedAt: new Date().toISOString(),
      });
  }

  updateDocumentSource(input: { documentId: string; title?: string; sourceUrl?: string | null }): void {
    this.#db
      .prepare(
        `UPDATE knowledge_documents
         SET title = COALESCE(@title, title),
             source_url = COALESCE(@sourceUrl, source_url),
             updated_at = @updatedAt
         WHERE id = @documentId`,
      )
      .run({
        documentId: input.documentId,
        title: input.title ?? null,
        sourceUrl: input.sourceUrl ?? null,
        updatedAt: new Date().toISOString(),
      });
  }

  setDocumentChunks(input: { documentId: string; chunks: IndexedKnowledgeChunk[] }): void {
    const write = this.#db.transaction((documentId: string, chunks: IndexedKnowledgeChunk[]) => {
      this.#db.prepare('DELETE FROM knowledge_chunks WHERE document_id = ?').run(documentId);
      if (this.#vecAvailable) {
        this.#db
          .prepare(
            `DELETE FROM knowledge_vec_chunks
             WHERE chunk_id NOT IN (SELECT id FROM knowledge_chunks)`,
          )
          .run();
      }
      const insertChunk = this.#db.prepare(
        `INSERT INTO knowledge_chunks (id, document_id, chunk_index, text, embedding)
         VALUES (@id, @documentId, @chunkIndex, @text, @embedding)`,
      );
      const insertVec = this.#vecAvailable
        ? this.#db.prepare('INSERT INTO knowledge_vec_chunks (chunk_id, embedding) VALUES (@chunkId, @embedding)')
        : undefined;
      chunks.forEach((chunk, chunkIndex) => {
        if (chunk.embedding.length !== this.#dimensions) {
          throw new Error(
            `Chunk embedding has ${String(chunk.embedding.length)} dimensions; expected ${String(this.#dimensions)}.`,
          );
        }
        const id = ulid();
        const embedding = embeddingToBuffer(chunk.embedding);
        insertChunk.run({ id, documentId, chunkIndex, text: chunk.text, embedding });
        insertVec?.run({ chunkId: id, embedding });
      });
      this.#db
        .prepare(
          `UPDATE knowledge_documents
           SET chunk_count = @chunkCount, updated_at = @updatedAt
           WHERE id = @documentId`,
        )
        .run({ documentId, chunkCount: chunks.length, updatedAt: new Date().toISOString() });
    });
    write(input.documentId, input.chunks);
  }

  deleteDocument(input: { documentId: string }): void {
    const remove = this.#db.transaction((documentId: string) => {
      this.#db.prepare('DELETE FROM knowledge_chunks WHERE document_id = ?').run(documentId);
      if (this.#vecAvailable) {
        this.#db
          .prepare(
            `DELETE FROM knowledge_vec_chunks
             WHERE chunk_id NOT IN (SELECT id FROM knowledge_chunks)`,
          )
          .run();
      }
      this.#db.prepare('DELETE FROM knowledge_documents WHERE id = ?').run(documentId);
    });
    remove(input.documentId);
  }

  countReadyChunks(): number {
    const row = this.#db
      .prepare(
        `SELECT COUNT(*) AS count FROM knowledge_chunks
         WHERE document_id IN (SELECT id FROM knowledge_documents WHERE status = 'ready')`,
      )
      .get();
    return CountRowSchema.parse(row).count;
  }

  usedBytes(): number {
    const row = this.#db
      .prepare(
        `SELECT (page_count - freelist_count) * page_size AS bytes
         FROM pragma_page_count(), pragma_freelist_count(), pragma_page_size()`,
      )
      .get();
    return UsedBytesRowSchema.parse(row).bytes;
  }

  searchNearest(input: { embedding: Float32Array; limit: number }): KnowledgeSearchHit[] {
    if (input.embedding.length !== this.#dimensions) {
      throw new Error(
        `Query embedding has ${String(input.embedding.length)} dimensions; expected ${String(this.#dimensions)}.`,
      );
    }
    return this.#vecAvailable
      ? this.#searchVec(input.embedding, input.limit)
      : this.#searchBruteForce(input.embedding, input.limit);
  }

  #searchVec(embedding: Float32Array, limit: number): KnowledgeSearchHit[] {
    // The KNN limit applies before the ready-status filter below, so a
    // library mid-indexing could return fewer than `limit` ready hits.
    // Over-fetch by the exact count of non-ready chunks: at most that many
    // of the k nearest can be non-ready, so at least `limit` ready ones
    // survive the filter. Steady state (nothing indexing) adds zero cost.
    const nonReady = CountRowSchema.parse(
      this.#db
        .prepare(
          `SELECT COUNT(*) AS count FROM knowledge_chunks c
           JOIN knowledge_documents d ON d.id = c.document_id
           WHERE d.status != 'ready'`,
        )
        .get(),
    ).count;
    const rawMatches = this.#db
      .prepare(
        `SELECT chunk_id, distance FROM knowledge_vec_chunks
         WHERE embedding MATCH ? AND k = ?
         ORDER BY distance`,
      )
      .all(embeddingToBuffer(embedding), limit + nonReady);
    const matches = z.array(VecMatchRowSchema).parse(rawMatches);
    if (matches.length === 0) {
      return [];
    }
    const byId = new Map(matches.map(match => [match.chunk_id, match.distance]));
    const placeholders = matches.map(() => '?').join(', ');
    const rawRows = this.#db
      .prepare(
        `SELECT c.id AS chunk_id, c.document_id, c.chunk_index, c.text,
                d.title, d.source_label, d.source_url
         FROM knowledge_chunks c
         JOIN knowledge_documents d ON d.id = c.document_id
         WHERE c.id IN (${placeholders}) AND d.status = 'ready'`,
      )
      .all(...matches.map(match => match.chunk_id));
    const rows = z.array(ChunkJoinRowSchema).parse(rawRows);
    return rows
      .map(row => {
        const distance = byId.get(row.chunk_id) ?? Number.POSITIVE_INFINITY;
        // Stored embeddings are L2-normalized: cosine similarity = 1 − d²/2.
        const similarity = 1 - (distance * distance) / 2;
        return {
          chunk_id: row.chunk_id,
          document_id: row.document_id,
          chunk_index: row.chunk_index,
          text: row.text,
          title: row.title,
          source_label: row.source_label,
          source_url: row.source_url,
          distance,
          similarity,
        };
      })
      .sort((a, b) => a.distance - b.distance)
      .slice(0, limit);
  }

  #searchBruteForce(embedding: Float32Array, limit: number): KnowledgeSearchHit[] {
    const rawRows = this.#db
      .prepare(
        `SELECT c.id AS chunk_id, c.document_id, c.chunk_index, c.text, c.embedding,
                d.title, d.source_label, d.source_url
         FROM knowledge_chunks c
         JOIN knowledge_documents d ON d.id = c.document_id
         WHERE d.status = 'ready'`,
      )
      .all();
    const rows = z.array(BruteForceRowSchema).parse(rawRows);
    return rows
      .map(row => {
        const distance = cosineDistance({ a: embedding, b: bufferToEmbedding(row.embedding, this.#dimensions) });
        return {
          chunk_id: row.chunk_id,
          document_id: row.document_id,
          chunk_index: row.chunk_index,
          text: row.text,
          title: row.title,
          source_label: row.source_label,
          source_url: row.source_url,
          distance,
          similarity: 1 - distance,
        };
      })
      .sort((a, b) => a.distance - b.distance)
      .slice(0, limit);
  }

  /**
   * Releases this handle's reference. The underlying database closes only
   * when the last reference is released; a handle built directly (tests)
   * closes immediately.
   */
  close(): void {
    if (this.#release === undefined) {
      this.#db.close();
      return;
    }
    this.#release();
  }

  /** Closes the database handle regardless of outstanding references. */
  closeDatabase(): void {
    this.#db.close();
  }
}

/**
 * Process-wide cache of open knowledge databases, keyed by file + embedding
 * dimensions. Per-turn retrieval must not pay the open ritual (mkdir, DDL,
 * migration check, native-extension dlopen) on every chat turn — the same
 * singleton pattern the embedding model and indexer already use.
 *
 * Handles are reference-counted: `close()` releases one reference and the
 * database closes when the last holder releases. Long-lived holders (the
 * indexer, per-turn retrieval) simply never call `close()`.
 */
const openRepositories = new Map<string, { repo: SqlitePersonaKnowledgeRepository; refs: number }>();

function repositoryCacheKey(dbPath: string, dimensions: number): string {
  return `${dbPath}::${String(dimensions)}`;
}

function releaseRepository(cacheKey: string): void {
  const entry = openRepositories.get(cacheKey);
  if (entry === undefined) {
    return;
  }
  entry.refs -= 1;
  if (entry.refs <= 0) {
    openRepositories.delete(cacheKey);
    entry.repo.closeDatabase();
  }
}

/**
 * Opens (creating when needed) the SQLite knowledge database at `dbPath`.
 * Tries the sqlite-vec extension first; when the native module cannot load
 * on the host, the same file still serves reads/writes through the
 * brute-force path — a slower library beats a lost one.
 *
 * The open handle is cached process-wide: the DDL/migration/vec-load ritual
 * runs once per database, not once per chat turn. Handles are
 * reference-counted — `close()` releases your reference; long-lived holders
 * (the indexer, per-turn retrieval) simply never call it.
 */
export function openPersonaKnowledgeRepository(input: {
  dbPath: string;
  dimensions?: number;
}): PersonaKnowledgeRepository {
  const dimensions = input.dimensions ?? 384;
  const cacheKey = repositoryCacheKey(input.dbPath, dimensions);
  const cached = openRepositories.get(cacheKey);
  if (cached !== undefined) {
    cached.refs += 1;
    return cached.repo;
  }
  // The library directory is created on first use: the per-persona SQLite file
  // lives under a knowledgeDir that may not exist yet (fresh install, tests).
  mkdirSync(path.dirname(input.dbPath), { recursive: true });
  const db = new Database(input.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  for (const statement of SCHEMA_STATEMENTS) {
    db.exec(statement);
  }
  // Migration for libraries created before the explicit-title flag existed:
  // CREATE TABLE IF NOT EXISTS never adds a column to an existing table.
  const columns = z
    .array(z.object({ name: z.string() }))
    .parse(db.prepare('PRAGMA table_info(knowledge_documents)').all());
  if (!columns.some(column => column.name === 'title_explicit')) {
    db.exec('ALTER TABLE knowledge_documents ADD COLUMN title_explicit INTEGER NOT NULL DEFAULT 0');
  }
  let vecAvailable = false;
  try {
    sqliteVec.load(db);
    db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_vec_chunks
       USING vec0(chunk_id TEXT PRIMARY KEY, embedding float[${String(dimensions)}])`,
    );
    vecAvailable = true;
    // Crash insurance: the vec index is written in the same transaction as
    // the chunk rows, so a count mismatch means an older writer — rebuild.
    const vecCount = CountRowSchema.parse(db.prepare('SELECT COUNT(*) AS count FROM knowledge_vec_chunks').get()).count;
    const chunkCount = CountRowSchema.parse(db.prepare('SELECT COUNT(*) AS count FROM knowledge_chunks').get()).count;
    if (vecCount !== chunkCount) {
      const rebuild = db.transaction(() => {
        db.exec('DELETE FROM knowledge_vec_chunks');
        const rows = z.array(RebuildRowSchema).parse(db.prepare('SELECT id, embedding FROM knowledge_chunks').all());
        const insert = db.prepare('INSERT INTO knowledge_vec_chunks (chunk_id, embedding) VALUES (?, ?)');
        for (const row of rows) {
          insert.run(row.id, embeddingToBuffer(bufferToEmbedding(row.embedding, dimensions)));
        }
      });
      rebuild();
    }
  } catch {
    // Extension unavailable on this host: fall back to brute-force search.
    // Nothing to log here — degraded search is the signal, never lost data.
    // (vecAvailable is already false.)
  }
  const repo = new SqlitePersonaKnowledgeRepository({
    db,
    dimensions,
    vecAvailable,
    release: () => {
      releaseRepository(cacheKey);
    },
  });
  openRepositories.set(cacheKey, { repo, refs: 1 });
  return repo;
}

/**
 * Closes and evicts every cached handle for `dbPath` (all dimension
 * variants). Call this when a persona's library database is deleted so no
 * stale handle keeps writing to the unlinked file.
 */
export function closePersonaKnowledgeRepository(input: { dbPath: string }): void {
  for (const key of [...openRepositories.keys()]) {
    if (key === input.dbPath || key.startsWith(`${input.dbPath}::`)) {
      const entry = openRepositories.get(key);
      openRepositories.delete(key);
      // Force-close regardless of outstanding references: the file is being
      // deleted, so any in-flight holder will fail fast on its next use and
      // reopen a fresh database.
      entry?.repo.closeDatabase();
    }
  }
}

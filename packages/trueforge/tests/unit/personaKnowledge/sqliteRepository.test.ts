import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SqlitePersonaKnowledgeRepository,
  closePersonaKnowledgeRepository,
  openPersonaKnowledgeRepository,
} from '../../../src/personaKnowledge/sqliteKnowledgeRepository';

const DIMENSIONS = 4;

function unitVector(seed: number): Float32Array {
  const vector = new Float32Array(DIMENSIONS);
  vector[seed % DIMENSIONS] = 1;
  return vector;
}

function setup() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE knowledge_documents (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, title_explicit INTEGER NOT NULL DEFAULT 0,
    source_kind TEXT NOT NULL,
    source_label TEXT NOT NULL, source_url TEXT, status TEXT NOT NULL,
    status_message TEXT, chunk_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`);
  db.exec(`CREATE TABLE knowledge_chunks (
    id TEXT PRIMARY KEY, document_id TEXT NOT NULL, chunk_index INTEGER NOT NULL,
    text TEXT NOT NULL, embedding BLOB NOT NULL
  )`);
  const repo = new SqlitePersonaKnowledgeRepository({ db, dimensions: DIMENSIONS, vecAvailable: false });
  return { repo, close: () => repo.close() };
}

describe('SqlitePersonaKnowledgeRepository (brute-force path)', () => {
  it('creates, reads, lists, and updates documents', () => {
    const { repo, close } = setup();
    try {
      const created = repo.createDocument({
        title: 'Exit story',
        titleExplicit: true,
        source_kind: 'text',
        source_label: 'Pasted text',
        source_url: null,
      });
      expect(created.status).toBe('pending');
      expect(created.chunk_count).toBe(0);

      const fetched = repo.getDocument({ documentId: created.id });
      expect(fetched?.title).toBe('Exit story');
      expect(fetched?.title_explicit).toBe(true);
      expect(repo.listDocuments()).toHaveLength(1);

      repo.updateDocumentStatus({ documentId: created.id, status: 'indexing' });
      expect(repo.getDocument({ documentId: created.id })?.status).toBe('indexing');

      repo.updateDocumentStatus({
        documentId: created.id,
        status: 'failed',
        statusMessage: 'No readable text was found.',
      });
      const failed = repo.getDocument({ documentId: created.id });
      expect(failed?.status).toBe('failed');
      expect(failed?.status_message).toBe('No readable text was found.');
    } finally {
      close();
    }
  });

  it('searches only ready documents and deletes with their chunks', () => {
    const { repo, close } = setup();
    try {
      const ready = repo.createDocument({
        title: 'Ready doc',
        titleExplicit: true,
        source_kind: 'text',
        source_label: 'Pasted text',
        source_url: null,
      });
      const draft = repo.createDocument({
        title: 'Draft doc',
        titleExplicit: true,
        source_kind: 'text',
        source_label: 'Pasted text',
        source_url: null,
      });
      repo.setDocumentChunks({
        documentId: ready.id,
        chunks: [{ text: 'sold the solo project for twenty million', embedding: unitVector(0) }],
      });
      repo.setDocumentChunks({
        documentId: draft.id,
        chunks: [{ text: 'unrelated draft content here', embedding: unitVector(0) }],
      });
      repo.updateDocumentStatus({ documentId: ready.id, status: 'ready' });
      expect(repo.countReadyChunks()).toBe(1);

      const hits = repo.searchNearest({ embedding: unitVector(0), limit: 5 });
      expect(hits).toHaveLength(1);
      expect(hits[0]?.document_id).toBe(ready.id);
      expect(hits[0]?.similarity).toBeCloseTo(1, 5);
      expect(hits[0]?.title).toBe('Ready doc');

      repo.deleteDocument({ documentId: ready.id });
      expect(repo.getDocument({ documentId: ready.id })).toBeUndefined();
      expect(repo.searchNearest({ embedding: unitVector(0), limit: 5 })).toHaveLength(0);
      expect(repo.countReadyChunks()).toBe(0);
    } finally {
      close();
    }
  });

  it('ranks by cosine similarity and respects the limit', () => {
    const { repo, close } = setup();
    try {
      const doc = repo.createDocument({
        title: 'Rank doc',
        titleExplicit: true,
        source_kind: 'text',
        source_label: 'Pasted text',
        source_url: null,
      });
      repo.setDocumentChunks({
        documentId: doc.id,
        chunks: [
          { text: 'exact match chunk', embedding: unitVector(1) },
          { text: 'orthogonal chunk', embedding: unitVector(2) },
        ],
      });
      repo.updateDocumentStatus({ documentId: doc.id, status: 'ready' });

      const hits = repo.searchNearest({ embedding: unitVector(1), limit: 1 });
      expect(hits).toHaveLength(1);
      expect(hits[0]?.text).toBe('exact match chunk');

      const both = repo.searchNearest({ embedding: unitVector(1), limit: 5 });
      expect(both).toHaveLength(2);
      expect(both[0]?.similarity ?? 0).toBeGreaterThan(both[1]?.similarity ?? 0);
    } finally {
      close();
    }
  });

  it('migrates libraries created before the explicit-title flag existed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'persona-knowledge-migration-'));
    const dbPath = join(dir, 'library.db');
    const legacy = new Database(dbPath);
    try {
      legacy.exec(`CREATE TABLE knowledge_documents (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, source_kind TEXT NOT NULL,
        source_label TEXT NOT NULL, source_url TEXT, status TEXT NOT NULL,
        status_message TEXT, chunk_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      )`);
      legacy.exec(`CREATE TABLE knowledge_chunks (
        id TEXT PRIMARY KEY, document_id TEXT NOT NULL, chunk_index INTEGER NOT NULL,
        text TEXT NOT NULL, embedding BLOB NOT NULL
      )`);
      legacy
        .prepare(
          `INSERT INTO knowledge_documents
             (id, title, source_kind, source_label, source_url, status, status_message, chunk_count, created_at, updated_at)
           VALUES ('doc1', 'Legacy title', 'text', 'Pasted text', NULL, 'ready', NULL, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
        )
        .run();
    } finally {
      legacy.close();
    }

    const repo = openPersonaKnowledgeRepository({ dbPath, dimensions: DIMENSIONS });
    try {
      const fetched = repo.getDocument({ documentId: 'doc1' });
      expect(fetched?.title).toBe('Legacy title');
      // Pre-flag documents were never user-titled at creation time.
      expect(fetched?.title_explicit).toBe(false);
    } finally {
      repo.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('shares one cached handle per database until every holder releases it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pk-cache-'));
    const dbPath = join(dir, 'lib.sqlite');
    try {
      const first = openPersonaKnowledgeRepository({ dbPath, dimensions: DIMENSIONS });
      const second = openPersonaKnowledgeRepository({ dbPath, dimensions: DIMENSIONS });
      expect(second).toBe(first);

      // One holder releasing must not close the database for the other.
      first.close();
      expect(() => second.listDocuments()).not.toThrow();

      second.close();
      // After the last release the entry is evicted: a fresh open re-runs
      // the open ritual instead of returning a closed handle.
      const third = openPersonaKnowledgeRepository({ dbPath, dimensions: DIMENSIONS });
      expect(third).not.toBe(first);
      expect(() => third.listDocuments()).not.toThrow();
      third.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('force-closes cached handles when a library database is deleted', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pk-evict-'));
    const dbPath = join(dir, 'lib.sqlite');
    try {
      const repo = openPersonaKnowledgeRepository({ dbPath, dimensions: DIMENSIONS });
      closePersonaKnowledgeRepository({ dbPath });
      expect(() => repo.listDocuments()).toThrow();
      // A later open recreates the database instead of reusing the stale handle.
      const reopened = openPersonaKnowledgeRepository({ dbPath, dimensions: DIMENSIONS });
      expect(() => reopened.listDocuments()).not.toThrow();
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

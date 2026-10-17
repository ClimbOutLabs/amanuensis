/**
 * Canonical contract for one persona's knowledge library. The vector store
 * sits behind this interface so the backend (sqlite-vec today) can be
 * swapped without touching ingestion, indexing, or retrieval.
 *
 * All text/vector writes go through `setDocumentChunks`, which replaces a
 * document's chunks and vectors atomically: a crash between parse and index
 * can only leave the document in a non-ready status, never a half-indexed
 * library.
 */
import type { KnowledgeDocumentStatus, KnowledgeSourceKind } from '../schemas/personaKnowledge';

export interface KnowledgeDocumentRecord {
  id: string;
  title: string;
  /** True when the user supplied the title explicitly (vs. defaulted from the source). */
  title_explicit: boolean;
  source_kind: KnowledgeSourceKind;
  /** Human-readable origin: file name, URL, or "Pasted text". */
  source_label: string;
  /** Final URL after redirects, for url sources only. */
  source_url: string | null;
  status: KnowledgeDocumentStatus;
  /** Plain-English explanation when status is failed. */
  status_message: string | null;
  chunk_count: number;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeSearchHit {
  chunk_id: string;
  document_id: string;
  chunk_index: number;
  text: string;
  title: string;
  source_label: string;
  source_url: string | null;
  /** Backend-defined ordering distance (lower is closer). */
  distance: number;
  /** Cosine similarity in [-1, 1]; the comparable relevance signal across backends. */
  similarity: number;
}

export interface NewKnowledgeDocument {
  title: string;
  /** True when the caller supplied the title explicitly. */
  titleExplicit: boolean;
  source_kind: KnowledgeSourceKind;
  source_label: string;
  source_url: string | null;
}

export interface IndexedKnowledgeChunk {
  text: string;
  embedding: Float32Array;
}

/** One stored chunk of a knowledge document, in reading order. Embeddings are derived data and never leave the repository. */
export interface KnowledgeDocumentChunk {
  chunkIndex: number;
  text: string;
}

export interface PersonaKnowledgeRepository {
  listDocuments(): KnowledgeDocumentRecord[];
  getDocument(input: { documentId: string }): KnowledgeDocumentRecord | undefined;
  /** The document's chunks (index and text only), ordered by chunk index. Backs the data export. */
  listDocumentChunks(input: { documentId: string }): KnowledgeDocumentChunk[];
  createDocument(input: NewKnowledgeDocument): KnowledgeDocumentRecord;
  updateDocumentStatus(input: {
    documentId: string;
    status: KnowledgeDocumentStatus;
    statusMessage?: string | null;
  }): void;
  /** Updates mutable source metadata (used to record a URL's final address after redirects). */
  updateDocumentSource(input: { documentId: string; title?: string; sourceUrl?: string | null }): void;
  /**
   * Atomically replaces the document's chunks and vectors. Implementations
   * must not leave partial chunk rows visible to readers.
   */
  setDocumentChunks(input: { documentId: string; chunks: IndexedKnowledgeChunk[] }): void;
  deleteDocument(input: { documentId: string }): void;
  countReadyChunks(): number;
  searchNearest(input: { embedding: Float32Array; limit: number }): KnowledgeSearchHit[];
  close(): void;
}

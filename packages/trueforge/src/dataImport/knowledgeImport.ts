import { link, rm } from 'node:fs/promises';

import { ensurePersonaKnowledgeRoot, personaKnowledgeLocation } from '../personaKnowledge/knowledgePaths';
import { openPersonaKnowledgeRepository } from '../personaKnowledge/sqliteKnowledgeRepository';
import { EMBEDDING_DIMENSIONS } from '../runtime/memory/embeddingModel';
import type { ImportKnowledgeDocument } from './importSchemas';

/** The slice of the embedding model that re-indexing needs. */
export interface KnowledgeEmbedder {
  /** False while the model is missing or still downloading. */
  ensureReady(): Promise<boolean>;
  embedPassages(texts: string[]): Promise<number[][]>;
}

const EMBED_BATCH_SIZE = 64;

/** Where the library is assembled before it is moved into place. */
function stagingPath(dbPath: string): string {
  return `${dbPath}.importing`;
}

/** Every file a library build can leave behind, final or staged. */
export async function removeKnowledgeFiles(dbPath: string): Promise<void> {
  for (const base of [dbPath, stagingPath(dbPath)]) {
    for (const suffix of ['', '-wal', '-shm']) {
      await rm(`${base}${suffix}`, { force: true });
    }
  }
}

async function embedAll(embedder: KnowledgeEmbedder, texts: readonly string[]): Promise<Float32Array[]> {
  const vectors: Float32Array[] = [];
  for (let start = 0; start < texts.length; start += EMBED_BATCH_SIZE) {
    const batch = await embedder.embedPassages(texts.slice(start, start + EMBED_BATCH_SIZE));
    for (const vector of batch) {
      if (vector.length !== EMBEDDING_DIMENSIONS) {
        throw new Error(
          `The embedding model returned ${String(vector.length)} values; expected ${String(EMBEDDING_DIMENSIONS)}.`,
        );
      }
      vectors.push(Float32Array.from(vector));
    }
  }
  if (vectors.length !== texts.length) {
    throw new Error('The embedding model returned the wrong number of vectors.');
  }
  return vectors;
}

/**
 * Builds a persona's knowledge library from exported chunk text, embedding it
 * with the local model. The library is assembled beside its final path and
 * linked into place only when whole, so an interrupted build never leaves a
 * half-written library where the app looks, and a library that already exists
 * is never touched.
 */
export async function writePersonaKnowledge(input: {
  knowledgeDir: string;
  tenantId: string;
  personaId: string;
  documents: readonly ImportKnowledgeDocument[];
  embedder: KnowledgeEmbedder;
}): Promise<string> {
  const { knowledgeDir, tenantId, personaId, documents, embedder } = input;
  await ensurePersonaKnowledgeRoot({ knowledgeDir, tenantId });
  const { dbPath } = personaKnowledgeLocation({ knowledgeDir, tenantId, personaId });
  const staged = stagingPath(dbPath);
  await removeKnowledgeFiles(staged);

  const ordered = documents.map(document => ({
    document,
    chunks: [...document.chunks].sort((a, b) => a.chunk_index - b.chunk_index),
  }));
  const embeddings = await embedAll(
    embedder,
    ordered.flatMap(entry => entry.chunks.map(chunk => chunk.text)),
  );

  const repository = openPersonaKnowledgeRepository({ dbPath: staged, dimensions: EMBEDDING_DIMENSIONS });
  try {
    let cursor = 0;
    for (const { document, chunks } of ordered) {
      const created = repository.createDocument({
        title: document.title,
        titleExplicit: document.title_explicit,
        source_kind: document.source_kind,
        source_label: document.source_label,
        source_url: document.source_url,
      });
      if (chunks.length > 0) {
        repository.setDocumentChunks({
          documentId: created.id,
          chunks: chunks.map(chunk => {
            const embedding = embeddings[cursor];
            cursor += 1;
            if (embedding === undefined) {
              throw new Error('The embedding model returned too few vectors.');
            }
            return { text: chunk.text, embedding };
          }),
        });
      }
      if (document.status === 'failed') {
        repository.updateDocumentStatus({
          documentId: created.id,
          status: 'failed',
          statusMessage: document.status_message,
        });
      } else if (chunks.length > 0) {
        repository.updateDocumentStatus({ documentId: created.id, status: 'ready', statusMessage: null });
      } else {
        // Indexing had not produced any text at export time, so there is nothing to search.
        repository.updateDocumentStatus({
          documentId: created.id,
          status: 'failed',
          statusMessage: 'This document had no indexed text when it was exported. Add it again.',
        });
      }
    }
  } finally {
    repository.close();
  }
  await rm(`${staged}-wal`, { force: true });
  await rm(`${staged}-shm`, { force: true });
  // A hard link fails when the final path exists, unlike a rename, which would replace it.
  await link(staged, dbPath);
  await rm(staged, { force: true });
  return dbPath;
}

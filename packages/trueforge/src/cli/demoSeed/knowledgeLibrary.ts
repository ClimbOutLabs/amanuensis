import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { blobPath, writeKnowledgeBlob } from '../../personaKnowledge/knowledgeIndexer';
import { ensurePersonaKnowledgeRoot, personaKnowledgeLocation } from '../../personaKnowledge/knowledgePaths';
import type { PersonaKnowledgeRepository } from '../../personaKnowledge/knowledgeRepository';
import {
  closePersonaKnowledgeRepository,
  openPersonaKnowledgeRepository,
} from '../../personaKnowledge/sqliteKnowledgeRepository';
import { EMBEDDING_DIMENSIONS } from '../../runtime/memory/embeddingModel';
import type { KnowledgeDocumentStatus } from '../../schemas/personaKnowledge';
import { DEMO_MARKER } from './world';

const SETTLE_POLL_MS = 500;
const SETTLED_STATUSES: readonly KnowledgeDocumentStatus[] = ['ready', 'failed'];

export interface KnowledgeDocumentSummary {
  id: string;
  title: string;
  source_label: string;
  status: KnowledgeDocumentStatus;
  status_message: string | null;
}

/** What the seed needs from a persona's knowledge library; the real one is the persona knowledge repository. */
export interface DemoKnowledgeLibrary {
  listDocuments(input: { personaId: string }): Promise<KnowledgeDocumentSummary[]>;
  /** Saves pasted text as a document and queues it for indexing. */
  addTextDocument(input: { personaId: string; title: string; text: string; sourceLabel: string }): Promise<void>;
  deleteDocument(input: { personaId: string; documentId: string }): Promise<void>;
  /** Removes the persona's whole library, database and queued files included. */
  deleteLibrary(input: { personaId: string }): Promise<void>;
  /** Waits until every document is ready or failed, or the time is up; returns the ones that are not ready. */
  settle(input: { personaId: string; timeoutMs: number }): Promise<KnowledgeDocumentSummary[]>;
}

/** The label a seeded document carries; the hash lets a changed text replace the old document. */
export function knowledgeSourceLabel(text: string): string {
  return `${DEMO_MARKER}:${createHash('sha256').update(text).digest('hex').slice(0, 12)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

export function createKnowledgeLibrary({
  knowledgeDir,
  tenantId,
  enqueue,
}: {
  knowledgeDir: string;
  tenantId: string;
  /** Hands a saved document to the indexer; the server's indexer in production. */
  enqueue: (input: { personaId: string; documentId: string }) => void;
}): DemoKnowledgeLibrary {
  const dbPathFor = (personaId: string): string =>
    personaKnowledgeLocation({ knowledgeDir, tenantId, personaId }).dbPath;

  const openRepo = (personaId: string) =>
    openPersonaKnowledgeRepository({ dbPath: dbPathFor(personaId), dimensions: EMBEDDING_DIMENSIONS });

  async function withRepository<T>(personaId: string, use: (repo: PersonaKnowledgeRepository) => T): Promise<T> {
    await ensurePersonaKnowledgeRoot({ knowledgeDir, tenantId });
    const repo = openRepo(personaId);
    try {
      return use(repo);
    } finally {
      repo.close();
    }
  }

  const list = (personaId: string): Promise<KnowledgeDocumentSummary[]> =>
    withRepository(personaId, repo =>
      repo.listDocuments().map(document => ({
        id: document.id,
        title: document.title,
        source_label: document.source_label,
        status: document.status,
        status_message: document.status_message,
      })),
    );

  return {
    listDocuments: ({ personaId }) => list(personaId),

    async addTextDocument({ personaId, title, text, sourceLabel }) {
      const documentId = await withRepository(
        personaId,
        repo =>
          repo.createDocument({
            title,
            titleExplicit: true,
            source_kind: 'text',
            source_label: sourceLabel,
            source_url: null,
          }).id,
      );
      // The text file must exist before the indexer is told about the document.
      await writeKnowledgeBlob({
        knowledgeDir,
        tenantId,
        personaId,
        documentId,
        bytes: new TextEncoder().encode(text),
      });
      enqueue({ personaId, documentId });
    },

    async deleteDocument({ personaId, documentId }) {
      await withRepository(personaId, repo => {
        repo.deleteDocument({ documentId });
      });
      await rm(blobPath({ knowledgeDir, tenantId, personaId, documentId }), { force: true });
    },

    async deleteLibrary({ personaId }) {
      const dbPath = dbPathFor(personaId);
      // Evict the cached handle first, or it would keep writing to the unlinked file.
      closePersonaKnowledgeRepository({ dbPath });
      for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
        await rm(file, { force: true });
      }
      await rm(path.resolve(knowledgeDir, tenantId, `${personaId}.blobs`), { force: true, recursive: true });
    },

    async settle({ personaId, timeoutMs }) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const documents = await list(personaId);
        if (documents.every(document => SETTLED_STATUSES.includes(document.status)) || Date.now() >= deadline) {
          return documents.filter(document => document.status !== 'ready');
        }
        await sleep(SETTLE_POLL_MS);
      }
    },
  };
}

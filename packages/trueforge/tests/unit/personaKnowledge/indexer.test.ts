import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const mockModel: {
  ready: boolean;
  ensureReady: () => Promise<boolean>;
  embedPassages: (texts: string[]) => Promise<number[][]>;
} = {
  ready: true,
  ensureReady: async () => mockModel.ready,
  embedPassages: async texts =>
    texts.map(() => {
      const vector = new Array<number>(384).fill(0);
      vector[0] = 1;
      return vector;
    }),
};

jest.mock('../../../src/runtime/memory/embeddingModel', () => ({
  EMBEDDING_DIMENSIONS: 384,
  getSharedEmbeddingModel: () => mockModel,
}));

import {
  PersonaKnowledgeIndexer,
  describeUserFacingFailure,
  writeKnowledgeBlob,
} from '../../../src/personaKnowledge/knowledgeIndexer';
import { personaKnowledgeLocation } from '../../../src/personaKnowledge/knowledgePaths';
import { openPersonaKnowledgeRepository } from '../../../src/personaKnowledge/sqliteKnowledgeRepository';
import type { KnowledgeDocumentStatus } from '../../../src/schemas/personaKnowledge';
import { DataDirConfigurationError, USER_FACING_STORAGE_UNAVAILABLE_MESSAGE } from '../../../src/utils/dataDir';

const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

function blobPath(knowledgeDir: string, personaId: string, documentId: string): string {
  return path.resolve(knowledgeDir, 'default', `${personaId}.blobs`, `${documentId}.bin`);
}

async function waitForStatus(
  knowledgeDir: string,
  personaId: string,
  documentId: string,
  status: KnowledgeDocumentStatus,
  timeoutMs = 15_000,
): Promise<void> {
  const { dbPath } = personaKnowledgeLocation({ knowledgeDir, tenantId: 'default', personaId });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const repo = openPersonaKnowledgeRepository({ dbPath, dimensions: 384 });
    try {
      const document = repo.getDocument({ documentId });
      if (document?.status === status) {
        return;
      }
    } finally {
      repo.close();
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for status ${status}`);
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

async function addTextDocument(
  knowledgeDir: string,
  indexer: PersonaKnowledgeIndexer,
  personaId: string,
  text: string,
): Promise<string> {
  const { dbPath } = personaKnowledgeLocation({ knowledgeDir, tenantId: 'default', personaId });
  const repo = openPersonaKnowledgeRepository({ dbPath, dimensions: 384 });
  const document = repo.createDocument({
    title: 'Test doc',
    titleExplicit: true,
    source_kind: 'text',
    source_label: 'Pasted text',
    source_url: null,
  });
  repo.close();
  await writeKnowledgeBlob({
    knowledgeDir,
    tenantId: 'default',
    personaId,
    documentId: document.id,
    bytes: new TextEncoder().encode(text),
  });
  indexer.enqueue({ tenantId: 'default', personaId, documentId: document.id });
  return document.id;
}

describe('PersonaKnowledgeIndexer', () => {
  it('drops a queued job whose persona was deleted instead of recreating a stray library file', async () => {
    mockModel.ready = true;
    const knowledgeDir = mkdtempSync(path.join(tmpdir(), 'pk-indexer-'));
    const indexer = new PersonaKnowledgeIndexer({ knowledgeDir, modelDir: path.join(knowledgeDir, 'm'), logger });
    // No document or library ever created for this persona: enqueueing
    // simulates a job that was still queued when the persona was deleted.
    indexer.enqueue({ tenantId: 'default', personaId: 'ghost', documentId: 'doc-ghost' });
    await new Promise(resolve => setTimeout(resolve, 500));
    const { dbPath } = personaKnowledgeLocation({ knowledgeDir, tenantId: 'default', personaId: 'ghost' });
    expect(existsSync(dbPath)).toBe(false);
    indexer.close();
  });

  it('indexes a text document end to end and cleans up the blob', async () => {
    mockModel.ready = true;
    const knowledgeDir = mkdtempSync(path.join(tmpdir(), 'pk-indexer-'));
    const indexer = new PersonaKnowledgeIndexer({ knowledgeDir, modelDir: path.join(knowledgeDir, 'm'), logger });
    const documentId = await addTextDocument(
      knowledgeDir,
      indexer,
      'zara',
      'The solo project sold for twenty million dollars. '.repeat(20),
    );

    await waitForStatus(knowledgeDir, 'zara', documentId, 'ready');

    const { dbPath } = personaKnowledgeLocation({ knowledgeDir, tenantId: 'default', personaId: 'zara' });
    const repo = openPersonaKnowledgeRepository({ dbPath, dimensions: 384 });
    try {
      const document = repo.getDocument({ documentId });
      expect(document?.status).toBe('ready');
      expect(document?.chunk_count).toBeGreaterThan(0);
      expect(repo.countReadyChunks()).toBe(document?.chunk_count);
    } finally {
      repo.close();
    }
    // Terminal state: the raw blob is gone, the indexed chunks remain. The
    // indexer deletes the blob after the status write lands, so poll instead
    // of asserting deletion in the same tick the 'ready' status is observed.
    const blobGoneDeadline = Date.now() + 10_000;
    for (;;) {
      if (!existsSync(blobPath(knowledgeDir, 'zara', documentId))) {
        break;
      }
      if (Date.now() > blobGoneDeadline) {
        throw new Error('Timed out waiting for the indexed blob to be deleted');
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    indexer.close();
  });

  it('pauses on a missing search model, keeps the blob, and fails after retries', async () => {
    mockModel.ready = false;
    const knowledgeDir = mkdtempSync(path.join(tmpdir(), 'pk-indexer-'));
    const indexer = new PersonaKnowledgeIndexer({ knowledgeDir, modelDir: path.join(knowledgeDir, 'm'), logger });
    const documentId = await addTextDocument(knowledgeDir, indexer, 'zara', 'Some text awaiting the model.');

    await waitForStatus(knowledgeDir, 'zara', documentId, 'indexing');

    const { dbPath } = personaKnowledgeLocation({ knowledgeDir, tenantId: 'default', personaId: 'zara' });
    const readMessage = () => {
      const repo = openPersonaKnowledgeRepository({ dbPath, dimensions: 384 });
      try {
        return repo.getDocument({ documentId })?.status_message ?? '';
      } finally {
        repo.close();
      }
    };
    expect(readMessage()).toContain('Paused');
    // The paused document's blob must survive for the retry.
    expect(existsSync(blobPath(knowledgeDir, 'zara', documentId))).toBe(true);

    // Three more attempts exhaust the retry budget (the first pause was attempt 1).
    for (let attempt = 0; attempt < 3; attempt += 1) {
      indexer.enqueue({ tenantId: 'default', personaId: 'zara', documentId });
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    await waitForStatus(knowledgeDir, 'zara', documentId, 'failed');
    expect(readMessage()).toContain('couldn’t be downloaded');
    // Terminal failure: the blob is finally cleaned up.
    expect(existsSync(blobPath(knowledgeDir, 'zara', documentId))).toBe(false);
    indexer.close();
    mockModel.ready = true;
  }, 30000);

  it('recover() re-queues documents orphaned by a restart', async () => {
    mockModel.ready = true;
    const knowledgeDir = mkdtempSync(path.join(tmpdir(), 'pk-indexer-'));
    const indexer = new PersonaKnowledgeIndexer({ knowledgeDir, modelDir: path.join(knowledgeDir, 'm'), logger });
    // Create the document directly in the DB without enqueueing, as a crash would leave it.
    const { dbPath } = personaKnowledgeLocation({ knowledgeDir, tenantId: 'default', personaId: 'zara' });
    const repo = openPersonaKnowledgeRepository({ dbPath, dimensions: 384 });
    const document = repo.createDocument({
      title: 'Orphan',
      titleExplicit: true,
      source_kind: 'text',
      source_label: 'Pasted text',
      source_url: null,
    });
    repo.close();
    await writeKnowledgeBlob({
      knowledgeDir,
      tenantId: 'default',
      personaId: 'zara',
      documentId: document.id,
      bytes: new TextEncoder().encode('Orphaned by a restart, still indexed.'),
    });

    await indexer.recover();
    await waitForStatus(knowledgeDir, 'zara', document.id, 'ready');
    indexer.close();
  });

  it('rejects traversal segments in writeKnowledgeBlob before creating any directory', async () => {
    const knowledgeDir = mkdtempSync(path.join(tmpdir(), 'pk-indexer-'));
    const evilDir = path.resolve(knowledgeDir, 'evil');
    await expect(
      writeKnowledgeBlob({
        knowledgeDir,
        tenantId: 'default',
        personaId: '../../evil',
        documentId: 'doc1',
        bytes: new TextEncoder().encode('x'),
      }),
    ).rejects.toThrow('not a valid library path segment');
    // Segment validation runs before mkdir: no directory escapes the root.
    expect(existsSync(evilDir)).toBe(false);
    await expect(
      writeKnowledgeBlob({
        knowledgeDir,
        tenantId: 'default',
        personaId: 'zara',
        documentId: '../escape',
        bytes: new TextEncoder().encode('x'),
      }),
    ).rejects.toThrow('not a valid library path segment');
  });

  it('maps a storage configuration failure to the static user-facing message', () => {
    // The status message reaches the knowledge UI; operator details (env var,
    // path, remediation) must never leak into it.
    const error = new DataDirConfigurationError({
      envVar: 'PERSONA_KNOWLEDGE_DIR',
      dir: '/secret/volumes/data',
      cause: new Error('EACCES: permission denied'),
    });
    expect(describeUserFacingFailure(error)).toBe(USER_FACING_STORAGE_UNAVAILABLE_MESSAGE);
    expect(describeUserFacingFailure(error)).not.toContain('PERSONA_KNOWLEDGE_DIR');
    expect(describeUserFacingFailure(error)).not.toContain('/secret/volumes/data');
    // Ordinary failures keep their plain-English rendering.
    expect(describeUserFacingFailure(new Error('boom'))).toContain('boom');
  });
});

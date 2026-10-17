import { OpenAPIHono } from '@hono/zod-openapi';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, mkdtempSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Response as UndiciResponse } from 'undici';
import { createLogger } from 'winston';

import { createPersonaKnowledgeRouter, MAX_LIBRARY_BYTES_PER_USER } from '../../../src/apis/personaKnowledge';
import { TENANT_ID } from '../../../src/apis/sessions';
import { createAppErrorHandler } from '../../../src/app';
import type { RequestContext } from '../../../src/auth/identity';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqlitePersonaStore } from '../../../src/db/sqlite/persona-store/SqlitePersonaStore';
import type { KnowledgeDocumentStatus } from '../../../src/schemas/personaKnowledge';

const mockModel = {
  currentPhase: 'ready' as 'ready' | 'unavailable',
  failureReason: '',
  ensureReady: async () => true,
  embedQueries: async (texts: string[]) =>
    texts.map(() => {
      const vector = new Array<number>(384).fill(0);
      vector[0] = 1;
      return vector;
    }),
  embedPassages: async (texts: string[]) =>
    texts.map(() => {
      const vector = new Array<number>(384).fill(0);
      vector[0] = 1;
      return vector;
    }),
};

jest.mock('../../../src/runtime/memory/embeddingModel', () => ({
  EMBEDDING_DIMENSIONS: 384,
  getSharedEmbeddingModel: () => mockModel,
  isEmbeddingModelCached: () => false,
}));

const userA: RequestContext = {
  tenant_id: 'default',
  subject: { id: 'user-a', type: 'user', display_name: 'user-a' },
  roles: [],
  user_credential: null,
};
const userB: RequestContext = {
  tenant_id: 'default',
  subject: { id: 'user-b', type: 'user', display_name: 'user-b' },
  roles: [],
  user_credential: null,
};

function jsonInit(method: string, body: unknown): RequestInit {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

const toBase64 = (text: string): string => Buffer.from(text, 'utf-8').toString('base64');

type KnowledgeDocumentWire = {
  id: string;
  title: string;
  title_explicit: boolean;
  source_kind: string;
  source_label: string;
  source_url: string | null;
  status: KnowledgeDocumentStatus;
  status_message: string | null;
  chunk_count: number;
};

async function setup(overrides?: { resolveAddresses?: (hostname: string) => Promise<string[]> }) {
  const db = createSqliteDb(':memory:');
  await migrateSqliteToLatest(db);
  const personaStore = new SqlitePersonaStore(db);
  await personaStore.createPersona({
    tenant_id: TENANT_ID,
    created_by: userA.subject.id,
    updated_by: userA.subject.id,
    id: 'persona-zara',
    display_name: 'Zara',
    aliases: [],
    instructions: 'Answer plainly.',
    model_name: 'scripted/model',
  });
  await personaStore.createPersona({
    tenant_id: TENANT_ID,
    created_by: userA.subject.id,
    updated_by: userA.subject.id,
    id: 'persona-mike',
    display_name: 'Mike',
    aliases: [],
    instructions: 'Answer plainly.',
    model_name: 'scripted/model',
  });

  let user = userA;
  const knowledgeDir = mkdtempSync(path.join(tmpdir(), 'pk-api-'));
  const fetchImpl = async (): Promise<UndiciResponse> =>
    new UndiciResponse(
      '<html><head><title>Solo Exit Story</title></head><body><p>The solo project sold for twenty million dollars.</p></body></html>',
      { headers: { 'content-type': 'text/html' }, status: 200 },
    );
  const app = new OpenAPIHono();
  app.route(
    '/',
    createPersonaKnowledgeRouter({
      personaStore,
      resolveRequestContext: () => user,
      knowledgeDir,
      modelDir: path.join(knowledgeDir, 'models'),
      logger: createLogger({ silent: true }),
      fetchImpl,
      resolveAddresses: overrides?.resolveAddresses ?? (async () => ['93.184.216.34']),
    }),
  );
  app.onError(createAppErrorHandler({ logger: createLogger({ silent: true }) }));

  const listDocuments = async (personaId: string): Promise<KnowledgeDocumentWire[]> => {
    const response = await app.request(`/${personaId}/knowledge`);
    expect(response.status).toBe(200);
    return ((await response.json()) as { data: KnowledgeDocumentWire[] }).data;
  };
  const waitForStatus = async (
    personaId: string,
    documentId: string,
    status: KnowledgeDocumentStatus,
  ): Promise<KnowledgeDocumentWire> => {
    const deadline = Date.now() + 20_000;
    for (;;) {
      const documents = await listDocuments(personaId);
      const document = documents.find(candidate => candidate.id === documentId);
      if (document?.status === status) {
        return document;
      }
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for ${status}; last saw ${document?.status}`);
      }
      await new Promise(resolve => setTimeout(resolve, 150));
    }
  };

  return {
    app,
    listDocuments,
    waitForStatus,
    knowledgeDir,
    as: (next: RequestContext) => {
      user = next;
    },
  };
}

describe('persona knowledge router', () => {
  it('adds pasted text and indexes it in the background', async () => {
    const { app, waitForStatus } = await setup();

    const created = await app.request(
      '/persona-zara/knowledge',
      jsonInit('POST', {
        kind: 'text',
        title: 'Exit story',
        text: 'The solo project sold for twenty million dollars.',
      }),
    );
    expect(created.status).toBe(201);
    const { data } = (await created.json()) as { data: KnowledgeDocumentWire };
    expect(data.status).toBe('pending');
    expect(data.title).toBe('Exit story');

    const ready = await waitForStatus('persona-zara', data.id, 'ready');
    expect(ready.chunk_count).toBeGreaterThan(0);
    expect(ready.status_message).toBeNull();
  });

  it('adds a file upload and rejects corrupt base64', async () => {
    const { app, waitForStatus } = await setup();

    const created = await app.request(
      '/persona-zara/knowledge',
      jsonInit('POST', {
        kind: 'upload',
        filename: 'notes.txt',
        content_base64: toBase64('Plain text notes about the exit.'),
      }),
    );
    expect(created.status).toBe(201);
    const { data } = (await created.json()) as { data: KnowledgeDocumentWire };
    await waitForStatus('persona-zara', data.id, 'ready');

    const corrupt = await app.request(
      '/persona-zara/knowledge',
      jsonInit('POST', { kind: 'upload', filename: 'notes.txt', content_base64: '!!!not-base64!!!' }),
    );
    expect(corrupt.status).toBe(400);
  });

  it('snapshots a URL, adopts the page title, and records the final URL', async () => {
    const { app, waitForStatus } = await setup();

    const created = await app.request(
      '/persona-zara/knowledge',
      jsonInit('POST', { kind: 'url', url: 'https://example.com/story' }),
    );
    expect(created.status).toBe(201);
    const { data } = (await created.json()) as { data: KnowledgeDocumentWire };

    const ready = await waitForStatus('persona-zara', data.id, 'ready');
    expect(ready.title).toBe('Solo Exit Story');
    expect(ready.title_explicit).toBe(false);
    expect(ready.source_url).toBe('https://example.com/story');
  });

  it('keeps an explicit URL title instead of the page title', async () => {
    const { app, waitForStatus } = await setup();

    const created = await app.request(
      '/persona-zara/knowledge',
      jsonInit('POST', { kind: 'url', url: 'https://example.com/story', title: 'My title' }),
    );
    const { data } = (await created.json()) as { data: KnowledgeDocumentWire };
    expect(data.title_explicit).toBe(true);
    const ready = await waitForStatus('persona-zara', data.id, 'ready');
    expect(ready.title).toBe('My title');
    expect(ready.title_explicit).toBe(true);
  });

  it('fails a blocked URL with a plain-English message, never a stack trace', async () => {
    // Echo resolver: IP literals resolve to themselves, so the link-local
    // address is caught by the guard.
    const { app, waitForStatus } = await setup({ resolveAddresses: async hostname => [hostname] });

    const blocked = await app.request(
      '/persona-zara/knowledge',
      jsonInit('POST', { kind: 'url', url: 'http://169.254.169.254/latest/meta-data' }),
    );
    expect(blocked.status).toBe(201);
    const { data } = (await blocked.json()) as { data: KnowledgeDocumentWire };
    const failed = await waitForStatus('persona-zara', data.id, 'failed');
    expect(failed.status_message).toContain('private or internal');
  });

  it('rejects non-http(s) URLs and URLs with embedded credentials at the schema layer', async () => {
    const { app } = await setup();

    for (const url of [
      'javascript:alert(document.cookie)',
      'data:text/html,<h1>hi</h1>',
      'https://user:secret@example.com/story',
      'http://user@example.com/',
    ]) {
      const rejected = await app.request('/persona-zara/knowledge', jsonInit('POST', { kind: 'url', url }));
      expect(rejected.status).toBe(400);
    }
  });

  it('isolates libraries per user and deletes documents', async () => {
    const { app, listDocuments, as } = await setup();

    const created = await app.request(
      '/persona-zara/knowledge',
      jsonInit('POST', { kind: 'text', title: 'Private', text: 'user A only' }),
    );
    const { data } = (await created.json()) as { data: KnowledgeDocumentWire };

    as(userB);
    expect((await app.request('/persona-zara/knowledge')).status).toBe(404);
    expect((await app.request(`/persona-zara/knowledge/${data.id}`, { method: 'DELETE' })).status).toBe(404);

    as(userA);
    expect((await app.request('/persona-zara/knowledge/nope', { method: 'DELETE' })).status).toBe(404);
    expect((await app.request(`/persona-zara/knowledge/${data.id}`, { method: 'DELETE' })).status).toBe(200);
    expect(await listDocuments('persona-zara')).toHaveLength(0);
  });

  it('refuses a new document once the user has filled their libraries across personas', async () => {
    const { app, knowledgeDir, listDocuments } = await setup();
    // A pending upload on another of the same user's personas already uses the whole allowance.
    const blobsDir = path.join(knowledgeDir, TENANT_ID, 'persona-mike.blobs');
    mkdirSync(blobsDir, { recursive: true });
    const pending = path.join(blobsDir, 'pending.bin');
    writeFileSync(pending, '');
    truncateSync(pending, MAX_LIBRARY_BYTES_PER_USER);

    const response = await app.request(
      '/persona-zara/knowledge',
      jsonInit('POST', { kind: 'upload', filename: 'notes.txt', content_base64: toBase64('invented notes') }),
    );

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { message: string } }).error.message).toMatch(/full/);
    expect(await listDocuments('persona-zara')).toHaveLength(0);
  });

  it('rejects a traversal document id on delete before touching the filesystem', async () => {
    const { app, knowledgeDir } = await setup();

    // The raw path.resolve the delete handler used to build would have aimed
    // a traversal id at this file: it must survive the request untouched.
    const sentinel = path.join(knowledgeDir, 'escape-target.bin');
    writeFileSync(sentinel, 'sentinel');

    // A list request creates the persona's knowledge database; plant a row
    // with a traversal-style id so the delete path reaches blob validation.
    expect((await app.request('/persona-zara/knowledge')).status).toBe(200);
    const db = new Database(path.join(knowledgeDir, TENANT_ID, 'persona-zara.sqlite'));
    try {
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO knowledge_documents
           (id, title, title_explicit, source_kind, source_label, source_url, status, status_message, chunk_count, created_at, updated_at)
         VALUES ('../../escape-target', 'Traversal', 1, 'text', 'Pasted text', NULL, 'pending', NULL, 0, @now, @now)`,
      ).run({ now });
    } finally {
      db.close();
    }

    const response = await app.request('/persona-zara/knowledge/..%2F..%2Fescape-target', {
      method: 'DELETE',
    });
    // Segment validation throws before the blob rm, so the request fails
    // without touching anything outside the library.
    expect(response.status).toBe(500);
    expect(existsSync(sentinel)).toBe(true);
  });

  it('reports the search model status in plain English', async () => {
    const { app } = await setup();
    const response = await app.request('/persona-zara/knowledge/embedding-model');
    expect(response.status).toBe(200);
    const { data } = (await response.json()) as { data: { phase: string; message: string } };
    expect(data.phase).toBe('ready');
    expect(data.message).toContain('Ready');
  });

  it('never leaks the embedding model failure detail to the UI', async () => {
    // The raw failure reason names the env var and the absolute model path:
    // it belongs in the server log, not in the 200 JSON response.
    mockModel.currentPhase = 'unavailable';
    mockModel.failureReason =
      "MEMORY_EMBEDDINGS_MODEL_DIR: data directory '/tmp/some/abs/models' is not writable (EACCES). " +
      'Set MEMORY_EMBEDDINGS_MODEL_DIR to a path this process can write, or mount a persistent Docker volume there.';
    try {
      const { app } = await setup();
      const response = await app.request('/persona-zara/knowledge/embedding-model');
      expect(response.status).toBe(200);
      const { data } = (await response.json()) as { data: { phase: string; message: string } };
      expect(data.phase).toBe('unavailable');
      expect(data.message).toBe(
        'The search model isn’t available right now. Your documents are saved and will index automatically once it is.',
      );
      expect(data.message).not.toContain('MEMORY_EMBEDDINGS_MODEL_DIR');
      expect(data.message).not.toContain('/tmp/some/abs/models');
      expect(data.message).not.toContain('EACCES');
    } finally {
      mockModel.currentPhase = 'ready';
      mockModel.failureReason = '';
    }
  });

  it('404s knowledge routes for an unknown persona', async () => {
    const { app } = await setup();
    expect((await app.request('/persona-nope/knowledge')).status).toBe(404);
  });

  it('keeps each persona’s library isolated from the others', async () => {
    const { app, listDocuments, waitForStatus } = await setup();

    const created = await app.request(
      '/persona-zara/knowledge',
      jsonInit('POST', { kind: 'text', title: 'Zara only', text: 'The solo project sold for twenty million dollars.' }),
    );
    expect(created.status).toBe(201);
    const { data } = (await created.json()) as { data: KnowledgeDocumentWire };
    await waitForStatus('persona-zara', data.id, 'ready');

    // Mike's library is empty and cannot see, fetch, or delete Zara's document.
    expect(await listDocuments('persona-mike')).toHaveLength(0);
    expect((await app.request(`/persona-mike/knowledge/${data.id}`, { method: 'DELETE' })).status).toBe(404);
    expect(await listDocuments('persona-zara')).toHaveLength(1);
  });

  it('rolls back the document row when the blob cannot be saved', async () => {
    const { app, listDocuments, knowledgeDir } = await setup();

    // A file where the persona's blob directory should be makes the atomic
    // blob write fail *after* the row was created — the row must be rolled
    // back so a retry never sees a phantom document.
    const blobsDir = path.join(knowledgeDir, TENANT_ID);
    mkdirSync(blobsDir, { recursive: true });
    writeFileSync(path.join(blobsDir, 'persona-zara.blobs'), 'not a directory');

    const created = await app.request(
      '/persona-zara/knowledge',
      jsonInit('POST', { kind: 'text', title: 'Doomed', text: 'This never lands.' }),
    );
    expect(created.status).toBe(500);
    const body = (await created.json()) as { error: { message: string } };
    expect(body.error.message).toContain('couldn’t be saved');
    expect(body.error.message).not.toContain('ENOTDIR');
    expect(await listDocuments('persona-zara')).toHaveLength(0);
  });

  it('reports a plain-English error when the library directory is unusable', async () => {
    const { app, knowledgeDir } = await setup();

    // A file where the tenant directory should be breaks the root ensure.
    writeFileSync(path.join(knowledgeDir, TENANT_ID), 'not a directory');

    const response = await app.request('/persona-zara/knowledge');
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toContain('couldn’t be opened');
    expect(body.error.message).not.toContain('EEXIST');
  });
});

import { OpenAPIHono, type RouteHandler } from '@hono/zod-openapi';
import { rm } from 'node:fs/promises';

import type { ResolveRequestContext } from '../auth/identity';
import type { IPersonaStore } from '../db/personaStore';
import { MAX_UPLOAD_BYTES, type FetchSnapshotOptions } from '../personaKnowledge/documentIngest';
import {
  blobPath,
  getPersonaKnowledgeIndexer,
  personaLibraryBytes,
  writeKnowledgeBlob,
} from '../personaKnowledge/knowledgeIndexer';
import { ensurePersonaKnowledgeRoot, personaKnowledgeLocation } from '../personaKnowledge/knowledgePaths';
import type { KnowledgeDocumentRecord } from '../personaKnowledge/knowledgeRepository';
import { openPersonaKnowledgeRepository } from '../personaKnowledge/sqliteKnowledgeRepository';
import {
  createPersonaKnowledgeRoute,
  deletePersonaKnowledgeRoute,
  getPersonaKnowledgeEmbeddingModelRoute,
  listPersonaKnowledgeRoute,
} from '../routes/personaKnowledgeRoutes';
import { EMBEDDING_DIMENSIONS, getSharedEmbeddingModel } from '../runtime/memory/embeddingModel';
import type { CreateKnowledgeDocumentRequest, PersonaKnowledgeDocument } from '../schemas/personaKnowledge';
import { TENANT_ID } from './sessions';

export interface PersonaKnowledgeRouterDeps {
  personaStore: IPersonaStore;
  resolveRequestContext: ResolveRequestContext;
  knowledgeDir: string;
  modelDir: string;
  logger: {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
  };
  /** Test seam: the URL snapshot fetcher the background indexer uses. */
  fetchImpl?: FetchSnapshotOptions['fetchImpl'];
  /** Test seam: DNS resolution for the URL snapshot fetcher. */
  resolveAddresses?: (hostname: string) => Promise<string[]>;
}

function toWireDocument(record: KnowledgeDocumentRecord): PersonaKnowledgeDocument {
  return {
    id: record.id,
    title: record.title,
    title_explicit: record.title_explicit,
    source_kind: record.source_kind,
    source_label: record.source_label,
    source_url: record.source_url,
    status: record.status,
    status_message: record.status_message,
    chunk_count: record.chunk_count,
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
}

/** Disk one user's knowledge libraries may fill, across all of their personas. */
export const MAX_LIBRARY_BYTES_PER_USER = 512 * 1024 * 1024;

function decodeUploadPayload(contentBase64: string, filename: string): Uint8Array {
  const compact = contentBase64.replace(/\s+/g, '');
  const bytes = Buffer.from(compact, 'base64');
  // Canonical round-trip: Buffer silently skips bad characters, so re-encode
  // and compare instead of trusting the decode.
  if (bytes.byteLength === 0 || bytes.toString('base64') !== compact) {
    throw new Error(`“${filename}” couldn’t be read — the upload looks corrupted. Try again.`);
  }
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    throw new Error(
      `“${filename}” is larger than ${String(MAX_UPLOAD_BYTES / 1024 / 1024)} MB, which is the current limit for one knowledge file.`,
    );
  }
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** Persona knowledge library (mounted at /api/v1/personas). */
export function createPersonaKnowledgeRouter(deps: PersonaKnowledgeRouterDeps) {
  const indexer = getPersonaKnowledgeIndexer({
    knowledgeDir: deps.knowledgeDir,
    modelDir: deps.modelDir,
    logger: deps.logger,
    fetchImpl: deps.fetchImpl,
    resolveAddresses: deps.resolveAddresses,
  });
  // Re-queue documents orphaned by a crash or restart. Runs once per process.
  void indexer.recover().catch((error: unknown) => {
    deps.logger.warn(`Persona knowledge recovery failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  });
  // The knowledge library needs the embedding model whether or not memory
  // embeddings are enabled: warm it at boot so a fresh process with ready
  // documents doesn't sit idle while the UI claims they're ready.
  // Fire-and-forget — startup never waits, and a failure degrades silently.
  void getSharedEmbeddingModel({ modelDir: deps.modelDir }).ensureReady();

  const withPersona = async (c: Parameters<RouteHandler<typeof listPersonaKnowledgeRoute>>[0], personaId: string) => {
    const requestContext = deps.resolveRequestContext(c);
    const persona = await deps.personaStore.getPersona({
      tenant_id: TENANT_ID,
      created_by: requestContext.subject.id,
      id: personaId,
    });
    if (persona === undefined) {
      return undefined;
    }
    return { subjectId: requestContext.subject.id };
  };

  const openRepo = (personaId: string) => {
    const { dbPath } = personaKnowledgeLocation({
      knowledgeDir: deps.knowledgeDir,
      tenantId: TENANT_ID,
      personaId,
    });
    return openPersonaKnowledgeRepository({ dbPath, dimensions: EMBEDDING_DIMENSIONS });
  };

  /**
   * The library directory must exist before any read or write. A failure here
   * is an ops problem (bad volume, permissions), so it surfaces as a
   * plain-English 500 with the original error preserved as the cause — never
   * a raw `EEXIST`/`EACCES` string in the UI.
   */
  const ensureLibraryRoot = async (): Promise<{ ok: true } | { ok: false; message: string }> => {
    try {
      await ensurePersonaKnowledgeRoot({ knowledgeDir: deps.knowledgeDir, tenantId: TENANT_ID });
      return { ok: true };
    } catch (error) {
      deps.logger.error(
        `Persona knowledge root unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
      return {
        ok: false,
        message: 'The knowledge library couldn’t be opened. Check the server’s storage and try again.',
      };
    }
  };

  const listHandler: RouteHandler<typeof listPersonaKnowledgeRoute> = async c => {
    const { persona_id: personaId } = c.req.valid('param');
    if ((await withPersona(c, personaId)) === undefined) {
      return c.json({ error: { message: `Persona not found: ${personaId}` } }, 404);
    }
    const root = await ensureLibraryRoot();
    if (!root.ok) {
      return c.json({ error: { message: root.message } }, 500);
    }
    const repo = openRepo(personaId);
    try {
      return c.json({ data: repo.listDocuments().map(toWireDocument) }, 200);
    } finally {
      repo.close();
    }
  };

  const userLibraryBytes = async (subjectId: string): Promise<number> => {
    const personas = await deps.personaStore.listPersonas({ tenant_id: TENANT_ID, created_by: subjectId });
    const sizes = await Promise.all(
      personas.map(persona =>
        personaLibraryBytes({ knowledgeDir: deps.knowledgeDir, tenantId: TENANT_ID, personaId: persona.id }),
      ),
    );
    return sizes.reduce((sum, size) => sum + size, 0);
  };

  const createHandler: RouteHandler<typeof createPersonaKnowledgeRoute> = async c => {
    const { persona_id: personaId } = c.req.valid('param');
    const owner = await withPersona(c, personaId);
    if (owner === undefined) {
      return c.json({ error: { message: `Persona not found: ${personaId}` } }, 404);
    }
    const body: CreateKnowledgeDocumentRequest = c.req.valid('json');
    const root = await ensureLibraryRoot();
    if (!root.ok) {
      return c.json({ error: { message: root.message } }, 500);
    }
    if ((await userLibraryBytes(owner.subjectId)) >= MAX_LIBRARY_BYTES_PER_USER) {
      return c.json(
        {
          error: {
            message: `Your knowledge libraries are full (${String(MAX_LIBRARY_BYTES_PER_USER / 1024 / 1024)} MB). Remove a document to add another.`,
          },
        },
        400,
      );
    }
    const repo = openRepo(personaId);
    try {
      // The blob must exist before the row is visible: a blob-write failure
      // rolls the row back so a retry never sees a phantom document. Returns
      // false (never throws) so the handler can answer with a plain-English
      // 500 instead of leaking the fs error.
      const persistBlob = async (documentId: string, bytes: Uint8Array): Promise<boolean> => {
        try {
          await writeKnowledgeBlob({
            knowledgeDir: deps.knowledgeDir,
            tenantId: TENANT_ID,
            personaId,
            documentId,
            bytes,
          });
          return true;
        } catch (error) {
          repo.deleteDocument({ documentId });
          deps.logger.error(
            `Persona knowledge blob write failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          return false;
        }
      };
      const blobSaveFailed = () => c.json({ error: { message: 'The document couldn’t be saved. Try again.' } }, 500);
      let document: KnowledgeDocumentRecord;
      switch (body.kind) {
        case 'upload': {
          let bytes: Uint8Array;
          try {
            bytes = decodeUploadPayload(body.content_base64, body.filename);
          } catch (error) {
            return c.json({ error: { message: error instanceof Error ? error.message : 'Invalid upload.' } }, 400);
          }
          document = repo.createDocument({
            title: body.title ?? body.filename,
            titleExplicit: body.title !== undefined,
            source_kind: 'upload',
            source_label: body.filename,
            source_url: null,
          });
          if (!(await persistBlob(document.id, bytes))) {
            return blobSaveFailed();
          }
          break;
        }
        case 'url': {
          document = repo.createDocument({
            title: body.title ?? body.url,
            titleExplicit: body.title !== undefined,
            source_kind: 'url',
            source_label: body.url,
            source_url: body.url,
          });
          break;
        }
        case 'text': {
          document = repo.createDocument({
            title: body.title,
            titleExplicit: true,
            source_kind: 'text',
            source_label: 'Pasted text',
            source_url: null,
          });
          if (!(await persistBlob(document.id, new TextEncoder().encode(body.text)))) {
            return blobSaveFailed();
          }
          break;
        }
      }
      indexer.enqueue({ tenantId: TENANT_ID, personaId, documentId: document.id });
      // Return the record as accepted: the background indexer may already be
      // moving it past 'pending' by the time we respond, so re-reading would
      // report a racy status. Clients watch progress via the list endpoint.
      return c.json({ data: toWireDocument(document) }, 201);
    } finally {
      repo.close();
    }
  };

  const deleteHandler: RouteHandler<typeof deletePersonaKnowledgeRoute> = async c => {
    const { persona_id: personaId, document_id: documentId } = c.req.valid('param');
    if ((await withPersona(c, personaId)) === undefined) {
      return c.json({ error: { message: `Persona not found: ${personaId}` } }, 404);
    }
    const root = await ensureLibraryRoot();
    if (!root.ok) {
      return c.json({ error: { message: root.message } }, 500);
    }
    const repo = openRepo(personaId);
    try {
      if (repo.getDocument({ documentId }) === undefined) {
        return c.json({ error: { message: `Knowledge document not found: ${documentId}` } }, 404);
      }
      repo.deleteDocument({ documentId });
    } finally {
      repo.close();
    }
    // The blob path goes through the same segment validation as the write
    // and indexer paths: a hostile documentId can never resolve outside the
    // persona's blob directory, even past the DB existence check above.
    const blob = blobPath({
      knowledgeDir: deps.knowledgeDir,
      tenantId: TENANT_ID,
      personaId,
      documentId,
    });
    await rm(blob, { force: true }).catch(() => undefined);
    return c.json({}, 200);
  };

  const embeddingModelHandler: RouteHandler<typeof getPersonaKnowledgeEmbeddingModelRoute> = async c => {
    const { persona_id: personaId } = c.req.valid('param');
    if ((await withPersona(c, personaId)) === undefined) {
      return c.json({ error: { message: `Persona not found: ${personaId}` } }, 404);
    }
    // Read-only: never triggers the download from a status check.
    const model = getSharedEmbeddingModel({ modelDir: deps.modelDir });
    const phase = model.currentPhase;
    if (phase === 'unavailable' && model.failureReason !== '') {
      // The failure reason can name the env var, the absolute model path, and
      // remediation: operator detail for the server log, never for the UI.
      deps.logger.error(`Knowledge embedding model unavailable: ${model.failureReason}`);
    }
    const message =
      phase === 'ready'
        ? 'Ready — new documents become searchable as soon as they finish indexing.'
        : phase === 'downloading'
          ? 'Downloading the search model (about 120 MB, one time only). Your documents will index automatically when it finishes.'
          : phase === 'loading'
            ? 'Loading the search model. Your documents will index automatically in a moment.'
            : phase === 'unavailable'
              ? 'The search model isn’t available right now. Your documents are saved and will index automatically once it is.'
              : 'Not downloaded yet. Add your first document and the search model downloads once, automatically (about 120 MB).';
    return c.json({ data: { phase, message } }, 200);
  };

  const router = new OpenAPIHono();
  router.openapi(listPersonaKnowledgeRoute, listHandler);
  router.openapi(createPersonaKnowledgeRoute, createHandler);
  router.openapi(deletePersonaKnowledgeRoute, deleteHandler);
  router.openapi(getPersonaKnowledgeEmbeddingModelRoute, embeddingModelHandler);
  return router;
}

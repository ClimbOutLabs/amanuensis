import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { EMBEDDING_DIMENSIONS, getSharedEmbeddingModel } from '../runtime/memory/embeddingModel';
import type { KnowledgeDocumentStatus, KnowledgeSourceKind } from '../schemas/personaKnowledge';
import { isDataDirConfigurationError, USER_FACING_STORAGE_UNAVAILABLE_MESSAGE } from '../utils/dataDir';
import { chunkText } from './documentChunking';
import { extractTextFromUpload, fetchUrlSnapshot, type FetchSnapshotOptions } from './documentIngest';
import { ensurePersonaKnowledgeRoot, personaKnowledgeLocation } from './knowledgePaths';
import type { PersonaKnowledgeRepository } from './knowledgeRepository';
import { openPersonaKnowledgeRepository } from './sqliteKnowledgeRepository';

export interface PersonaKnowledgeIndexerOptions {
  knowledgeDir: string;
  modelDir: string;
  logger: { info(message: string): void; warn(message: string): void; error(message: string): void };
  fetchImpl?: FetchSnapshotOptions['fetchImpl'];
  resolveAddresses?: FetchSnapshotOptions['resolveAddresses'];
}

interface QueuedDocument {
  tenantId: string;
  personaId: string;
  documentId: string;
}

const MICRO_BATCH_SIZE = 2;
/**
 * Breather between micro-batches. This yields the event loop; it does not
 * throttle total CPU — the honest bound it provides is on latency: an
 * interactive query embedding shares the process-wide embed queue, so it
 * waits at most one micro-batch behind background indexing.
 */
const BATCH_COOLDOWN_MS = 25;
const MODEL_RETRY_DELAY_MS = 5 * 60 * 1000;
const MAX_MODEL_RETRIES = 3;
const RETRYABLE_STATUSES: readonly KnowledgeDocumentStatus[] = ['pending', 'parsing', 'indexing'];

/**
 * A single path segment is safe only when it can't escape its directory:
 * no separators, no parent traversal, no empties or control characters.
 */
function assertSafeSegment(name: string, value: string): void {
  let hasControlChar = false;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      hasControlChar = true;
      break;
    }
  }
  if (
    value.length === 0 ||
    value === '.' ||
    value === '..' ||
    value.includes('/') ||
    value.includes('\\') ||
    hasControlChar
  ) {
    throw new Error(`${name} is not a valid library path segment.`);
  }
}

/**
 * Resolves a document's blob path, rejecting traversal segments. Exported so
 * the API layer's delete path validates through the same gate as the write
 * and indexer paths.
 */
export function blobPath(input: {
  knowledgeDir: string;
  tenantId: string;
  personaId: string;
  documentId: string;
}): string {
  assertSafeSegment('tenantId', input.tenantId);
  assertSafeSegment('personaId', input.personaId);
  assertSafeSegment('documentId', input.documentId);
  return path.resolve(input.knowledgeDir, input.tenantId, `${input.personaId}.blobs`, `${input.documentId}.bin`);
}

function describeFailure(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return 'Something went wrong while preparing this document. Try uploading it again.';
}

/**
 * Renders a caught indexing error for the knowledge UI's status message.
 * Storage misconfiguration is an operator problem, so it gets a static
 * sentence — never the env var, path, or `-v` remediation from the thrown
 * error. The log line below keeps the full detail. Exported for unit tests.
 */
export function describeUserFacingFailure(error: unknown): string {
  return isDataDirConfigurationError(error) ? USER_FACING_STORAGE_UNAVAILABLE_MESSAGE : describeFailure(error);
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Background indexer for persona knowledge libraries.
 *
 * One document is processed at a time, FIFO, embedded in small micro-batches
 * with a short breather between them: a chat turn's smart-search query waits
 * at most one micro-batch behind indexing, and the event loop is yielded
 * regularly. Indexing still uses significant CPU while it runs — the bound
 * is on interactive latency, not total CPU. Documents interrupted by a crash
 * or restart are re-queued by `recover()` because only the terminal states
 * (ready/failed) are sticky.
 */
export class PersonaKnowledgeIndexer {
  readonly #knowledgeDir: string;
  readonly #modelDir: string;
  readonly #logger: PersonaKnowledgeIndexerOptions['logger'];
  readonly #fetchImpl: FetchSnapshotOptions['fetchImpl'];
  readonly #resolveAddresses: FetchSnapshotOptions['resolveAddresses'];
  readonly #queue: QueuedDocument[] = [];
  readonly #queuedKeys = new Set<string>();
  readonly #modelRetries = new Map<string, number>();
  #processing = false;
  #pumping: Promise<void> = Promise.resolve();
  #closed = false;
  #recovered = false;

  constructor(options: PersonaKnowledgeIndexerOptions) {
    this.#knowledgeDir = options.knowledgeDir;
    this.#modelDir = options.modelDir;
    this.#logger = options.logger;
    this.#fetchImpl = options.fetchImpl;
    this.#resolveAddresses = options.resolveAddresses;
  }

  /** Queue a document for indexing. Idempotent per document while queued. */
  enqueue(input: { tenantId: string; personaId: string; documentId: string }): void {
    const key = `${input.tenantId}/${input.personaId}/${input.documentId}`;
    if (this.#closed || this.#queuedKeys.has(key)) {
      return;
    }
    this.#queuedKeys.add(key);
    this.#queue.push({ tenantId: input.tenantId, personaId: input.personaId, documentId: input.documentId });
    this.#pump();
  }

  /**
   * Re-queue documents left in a non-terminal state by a crash or restart.
   * Runs once per process; safe to call repeatedly.
   */
  async recover(): Promise<void> {
    if (this.#recovered || this.#closed) {
      return;
    }
    this.#recovered = true;
    let tenants: string[];
    try {
      tenants = await readdir(this.#knowledgeDir);
    } catch {
      return;
    }
    for (const tenantId of tenants) {
      let entries: string[];
      try {
        entries = await readdir(path.resolve(this.#knowledgeDir, tenantId));
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.endsWith('.sqlite')) {
          continue;
        }
        const personaId = entry.slice(0, -'.sqlite'.length);
        // The repo handle is cached process-wide; listing here warms the
        // cache the background queue will reuse. Never closed per-document.
        const repo = this.#openRepo({ dbPath: path.resolve(this.#knowledgeDir, tenantId, entry) });
        for (const document of repo.listDocuments()) {
          if (RETRYABLE_STATUSES.includes(document.status)) {
            this.enqueue({ tenantId, personaId, documentId: document.id });
          }
        }
      }
    }
  }

  /** Stops taking jobs and resolves once the document being indexed, if any, is finished. */
  async close(): Promise<void> {
    this.#closed = true;
    await this.#pumping;
  }

  #pump(): void {
    if (this.#processing) {
      return;
    }
    this.#pumping = this.#drain().catch((error: unknown) => {
      this.#logger.error(`Knowledge indexing stopped unexpectedly: ${describeFailure(error)}`);
    });
  }

  async #drain(): Promise<void> {
    this.#processing = true;
    try {
      while (!this.#closed) {
        const next = this.#queue.shift();
        if (next === undefined) {
          return;
        }
        this.#queuedKeys.delete(`${next.tenantId}/${next.personaId}/${next.documentId}`);
        await this.#processOne(next);
      }
    } finally {
      this.#processing = false;
    }
  }

  #openRepo(input: { dbPath: string }): PersonaKnowledgeRepository {
    return openPersonaKnowledgeRepository({ dbPath: input.dbPath, dimensions: EMBEDDING_DIMENSIONS });
  }

  async #processOne(queued: QueuedDocument): Promise<void> {
    const key = `${queued.tenantId}/${queued.personaId}/${queued.documentId}`;
    const { dbPath } = personaKnowledgeLocation({
      knowledgeDir: this.#knowledgeDir,
      tenantId: queued.tenantId,
      personaId: queued.personaId,
    });
    // If the persona's library file is gone (persona deleted while this
    // document was queued), drop the job: opening the repository would
    // recreate a stray empty file.
    try {
      await stat(dbPath);
    } catch (error) {
      // A missing library file means the persona was deleted while this job
      // was queued. Anything else (permissions, I/O) is unexpected — log it
      // so it can't be misread as a deleted persona.
      if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') {
        this.#logger.warn(
          `Dropping queued knowledge job for persona ${queued.personaId}: cannot stat its library (${error instanceof Error ? error.message : 'unknown error'}).`,
        );
      }
      return;
    }
    const repo = this.#openRepo({ dbPath });
    // The blob is the document's raw bytes; it is deleted only once the
    // document reaches a terminal state. A model-download pause schedules a
    // retry, and that retry needs the blob still there.
    let deleteBlob = true;
    try {
      const document = repo.getDocument({ documentId: queued.documentId });
      if (document === undefined || document.status === 'ready' || document.status === 'failed') {
        return;
      }
      this.#logger.info(`Indexing knowledge document ${queued.documentId} for persona ${queued.personaId}.`);
      repo.updateDocumentStatus({ documentId: queued.documentId, status: 'parsing' });

      const extracted = await this.#extractText(repo, queued, document.source_kind, document.source_label);
      repo.updateDocumentStatus({ documentId: queued.documentId, status: 'indexing' });

      const { chunks, truncated } = chunkText(extracted.text);
      if (chunks.length === 0) {
        throw new Error('No readable text was found — the file may be empty or image-only.');
      }

      const model = getSharedEmbeddingModel({
        modelDir: this.#modelDir,
        log: message => {
          this.#logger.info(message);
        },
      });
      const ready = await model.ensureReady();
      if (!ready) {
        // Terminal when the retry budget is exhausted: the blob is deleted
        // below (deleteBlob stays true) and the document is marked failed.
        // A scheduled retry keeps the blob (deleteBlob = false) so the next
        // attempt can read it.
        const terminal = this.#handleModelUnavailable(repo, queued, key);
        if (terminal) {
          repo.updateDocumentStatus({
            documentId: queued.documentId,
            status: 'failed',
            statusMessage:
              'The search model couldn’t be downloaded after several tries. Check your connection, then add the document again.',
          });
        } else {
          deleteBlob = false;
        }
        return;
      }
      this.#modelRetries.delete(key);

      const embeddings: Float32Array[] = [];
      // Micro-batches, not one big batch per loop: every embed in the process
      // shares a single serialized queue, and one 8-passage ONNX batch can
      // run ~1-2s of CPU. With micro-batches a chat turn's smart-search query
      // waits at most ~one micro-batch behind background indexing.
      for (let offset = 0; offset < chunks.length; offset += MICRO_BATCH_SIZE) {
        const batch = chunks.slice(offset, offset + MICRO_BATCH_SIZE);
        const vectors = await model.embedPassages(batch);
        for (const vector of vectors) {
          embeddings.push(Float32Array.from(vector));
        }
        if (this.#closed && offset + MICRO_BATCH_SIZE < chunks.length) {
          // Shutdown waits for at most one batch. The document stays retryable and keeps its blob,
          // so recovery indexes it again on the next start.
          deleteBlob = false;
          repo.updateDocumentStatus({
            documentId: queued.documentId,
            status: 'indexing',
            statusMessage: 'Paused while the app restarts. Indexing resumes automatically.',
          });
          this.#logger.info(`Knowledge indexing for ${key} paused for shutdown.`);
          return;
        }
        // Yield so a long document can't monopolize the event loop or CPU.
        await sleep(BATCH_COOLDOWN_MS);
      }
      if (embeddings.length !== chunks.length) {
        throw new Error('The search model returned an unexpected result. Try again in a moment.');
      }
      repo.setDocumentChunks({
        documentId: queued.documentId,
        chunks: chunks.map((text, index) => ({
          text,
          embedding: embeddings[index] ?? new Float32Array(EMBEDDING_DIMENSIONS),
        })),
      });
      // A saved link adopts the page's title only when the user didn't supply
      // one; the final URL after redirects is always recorded.
      const sourceUpdates: { title?: string; sourceUrl?: string | null } = {};
      if (extracted.pageTitle !== undefined && extracted.pageTitle !== '' && !document.title_explicit) {
        sourceUpdates.title = extracted.pageTitle;
      }
      if (extracted.finalSourceUrl !== undefined) {
        sourceUpdates.sourceUrl = extracted.finalSourceUrl;
      }
      if (sourceUpdates.title !== undefined || sourceUpdates.sourceUrl !== undefined) {
        repo.updateDocumentSource({ documentId: queued.documentId, ...sourceUpdates });
      }
      const truncationNotes = [
        extracted.note,
        truncated ? 'Only the first 500,000 characters were indexed.' : null,
      ].filter((note): note is string => typeof note === 'string');
      repo.updateDocumentStatus({
        documentId: queued.documentId,
        status: 'ready',
        statusMessage: truncationNotes.length > 0 ? truncationNotes.join(' ') : null,
      });
      this.#logger.info(`Knowledge document ${queued.documentId} is ready (${String(chunks.length)} chunks).`);
    } catch (error) {
      this.#logger.warn(`Knowledge indexing failed for ${key}: ${describeFailure(error)}`);
      try {
        repo.updateDocumentStatus({
          documentId: queued.documentId,
          status: 'failed',
          statusMessage: describeUserFacingFailure(error),
        });
      } catch {
        // The status write is best-effort; the document stays non-ready either way.
      }
    } finally {
      if (deleteBlob) {
        await rm(
          blobPath({
            knowledgeDir: this.#knowledgeDir,
            tenantId: queued.tenantId,
            personaId: queued.personaId,
            documentId: queued.documentId,
          }),
          { force: true },
        ).catch(() => undefined);
      }
      // The repo handle stays cached process-wide; never closed per-document.
    }
  }

  /**
   * Parks the document while the one-time search model download is pending.
   * Returns true when the retry budget is exhausted and the caller should
   * mark the document failed (the blob is then cleaned up as terminal);
   * otherwise schedules a retry and returns false (the blob is preserved).
   */
  #handleModelUnavailable(repo: PersonaKnowledgeRepository, queued: QueuedDocument, key: string): boolean {
    const attempts = (this.#modelRetries.get(key) ?? 0) + 1;
    this.#modelRetries.set(key, attempts);
    if (attempts > MAX_MODEL_RETRIES) {
      this.#modelRetries.delete(key);
      return true;
    }
    repo.updateDocumentStatus({
      documentId: queued.documentId,
      status: 'indexing',
      statusMessage:
        'Paused: waiting for the one-time search model download to finish. Indexing resumes automatically.',
    });
    this.#logger.info(`Knowledge indexing for ${key} paused until the search model is available.`);
    setTimeout(() => {
      this.enqueue(queued);
    }, MODEL_RETRY_DELAY_MS).unref();
    return false;
  }

  async #extractText(
    repo: PersonaKnowledgeRepository,
    queued: QueuedDocument,
    sourceKind: KnowledgeSourceKind,
    sourceLabel: string,
  ): Promise<{ text: string; finalSourceUrl?: string; pageTitle?: string; note?: string }> {
    if (sourceKind === 'url') {
      const document = repo.getDocument({ documentId: queued.documentId });
      const url = document?.source_url;
      if (url === null || url === undefined) {
        throw new Error('The saved link is missing. Try adding the URL again.');
      }
      const snapshot = await fetchUrlSnapshot(url, {
        ...(this.#fetchImpl === undefined ? {} : { fetchImpl: this.#fetchImpl }),
        ...(this.#resolveAddresses === undefined ? {} : { resolveAddresses: this.#resolveAddresses }),
      });
      return {
        text: snapshot.text,
        finalSourceUrl: snapshot.finalUrl,
        pageTitle: snapshot.title,
        ...(snapshot.note === undefined ? {} : { note: snapshot.note }),
      };
    }
    const raw = await readFile(
      blobPath({
        knowledgeDir: this.#knowledgeDir,
        tenantId: queued.tenantId,
        personaId: queued.personaId,
        documentId: queued.documentId,
      }),
    ).catch(() => undefined);
    if (raw === undefined) {
      throw new Error('The uploaded file is no longer available. Try uploading it again.');
    }
    if (sourceKind === 'text') {
      const text = new TextDecoder('utf-8', { fatal: false }).decode(raw).trim();
      if (text.length === 0) {
        throw new Error('The pasted text was empty.');
      }
      return { text };
    }
    const extracted = await extractTextFromUpload({
      filename: sourceLabel,
      bytes: new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength),
    });
    return { text: extracted.text, ...(extracted.note === undefined ? {} : { note: extracted.note }) };
  }
}

const indexers = new Map<string, PersonaKnowledgeIndexer>();

/** Process-wide indexer per knowledge directory. The first caller's logger wins. */
export function getPersonaKnowledgeIndexer(options: PersonaKnowledgeIndexerOptions): PersonaKnowledgeIndexer {
  const existing = indexers.get(options.knowledgeDir);
  if (existing !== undefined) {
    return existing;
  }
  const indexer = new PersonaKnowledgeIndexer(options);
  indexers.set(options.knowledgeDir, indexer);
  return indexer;
}

/** Stops every process-wide indexer and waits for their current documents, so shutdown never cuts a write. */
export async function closePersonaKnowledgeIndexers(): Promise<void> {
  const open = [...indexers.values()];
  indexers.clear();
  await Promise.all(open.map(indexer => indexer.close()));
}

/** Bytes one persona's library uses: its live database data and any blobs still waiting to be indexed. */
export async function personaLibraryBytes(input: {
  knowledgeDir: string;
  tenantId: string;
  personaId: string;
}): Promise<number> {
  const { dbPath } = personaKnowledgeLocation(input);
  const blobsDir = path.dirname(blobPath({ ...input, documentId: 'size-probe' }));
  const sizeOf = async (file: string): Promise<number> => {
    try {
      return (await stat(file)).size;
    } catch {
      // A file that is not there yet holds nothing.
      return 0;
    }
  };
  let blobNames: string[] = [];
  try {
    blobNames = await readdir(blobsDir);
  } catch {
    // No uploads are pending.
  }
  const blobSizes = await Promise.all(blobNames.map(name => sizeOf(path.join(blobsDir, name))));
  let libraryBytes = 0;
  // Checked first because opening a missing library would create it.
  if ((await sizeOf(dbPath)) > 0) {
    const repo = openPersonaKnowledgeRepository({ dbPath, dimensions: EMBEDDING_DIMENSIONS });
    try {
      libraryBytes = repo.usedBytes();
    } finally {
      repo.close();
    }
  }
  return blobSizes.reduce((sum, size) => sum + size, libraryBytes);
}

/** Persists the raw upload bytes for the background indexer. Exported for the API layer. */
export async function writeKnowledgeBlob(input: {
  knowledgeDir: string;
  tenantId: string;
  personaId: string;
  documentId: string;
  bytes: Uint8Array;
}): Promise<void> {
  await ensurePersonaKnowledgeRoot({ knowledgeDir: input.knowledgeDir, tenantId: input.tenantId });
  // Validate every segment before touching the filesystem: blobPath rejects
  // traversal segments, and mkdir-ing the `${personaId}.blobs` directory first
  // would create arbitrary directories as the app user for a hostile personaId.
  const finalPath = blobPath(input);
  const dir = path.dirname(finalPath);
  await mkdir(dir, { recursive: true });
  // Atomic write: the indexer must never see a half-written blob.
  const tempPath = `${finalPath}.tmp`;
  await writeFile(tempPath, input.bytes);
  await rename(tempPath, finalPath);
}

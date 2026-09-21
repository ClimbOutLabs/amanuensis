/**
 * Lazy loader for the on-device embedding model behind meaning-based recall.
 * The model is pinned (id + HF revision + SHA-256 of every file) because
 * retrieval quality depends on the exact evaluated model. Downloads fetch the
 * pinned files as raw bytes (never parsed); the file set and hashes are
 * verified next, and only then is the pipeline instantiated offline — so
 * unverified bytes never reach the ONNX parser. A structurally corrupt cache
 * is wiped before downloading, and every failure degrades to keyword-only. A
 * unit-norm canary guards against a corrupt-but-present cache.
 */
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { withTimeout } from '@truefoundry/trueforge-core/core';

/** Pinned by the retrieval eval; do not change without re-running the eval. */
export const EMBEDDING_MODEL_ID = 'Xenova/multilingual-e5-small';
export const EMBEDDING_MODEL_REVISION = '761b726dd34fb83930e26aab4e9ac3899aa1fa78';
export const EMBEDDING_DIMENSIONS = 384;
/** E5 requires these prefixes; the embed methods apply them unconditionally. */
export const EMBEDDING_QUERY_PREFIX = 'query: ';
export const EMBEDDING_PASSAGE_PREFIX = 'passage: ';

/** One-time download size, for plain-English status messages. */
export const EMBEDDING_MODEL_DOWNLOAD_SIZE = 'about 120 MB';

/**
 * Trust anchor: SHA-256 of every file the pinned revision must contain, measured
 * 2026-09-20. Do not change without re-running the retrieval eval.
 */
const EMBEDDING_MODEL_FILES: Record<string, string> = {
  'config.json': 'cb99455288675345e1a4f411438d5d0adbba5fbd3a67ea4fb03c015433b996c1',
  'tokenizer.json': '0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39',
  'tokenizer_config.json': 'a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b',
  'onnx/model_quantized.onnx': 'f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193',
};

const CANARY_TEXT = 'the quick brown fox jumps over the lazy dog';
const DOWNLOAD_RETRY_DELAY_MS = 2000;
/** Generous: a 120 MB download on a slow link, plus model warmup. */
const LOAD_TIMEOUT_MS = 15 * 60 * 1000;
/** Upper bound per downloaded file; the largest pinned file is about 110 MB. */
const MAX_DOWNLOAD_FILE_BYTES = 256 * 1024 * 1024;
/**
 * How long an 'unavailable' model stays latched before a later ensureReady()
 * retries the load. Matches the warm retry cooldown in embeddingRetrieval, so
 * a transient failure (locked file, brief I/O error) recovers on a later turn
 * instead of disabling smart search for the process.
 */
const UNAVAILABLE_RETRY_COOLDOWN_MS = 60_000;

export type EmbeddingModelPhase = 'idle' | 'loading' | 'downloading' | 'ready' | 'unavailable';

/**
 * The narrow slice of the transformers feature-extraction pipeline this module
 * uses. The real pipeline is adapted to this shape once, at the boundary, so the
 * rest of this module (and tests) never touch the heavy dependency's types.
 */
export type EmbeddingPipeline = (
  texts: string[],
  options: { pooling: 'mean'; normalize: boolean },
) => Promise<{ tolist: () => unknown }>;

export interface EmbeddingModelOptions {
  modelDir: string;
  log?: ((message: string) => void) | undefined;
  /**
   * Test seam: builds the pipeline instead of the default (transformers.js
   * pipeline + cache/env setup). Production leaves this unset. Always receives
   * the verified local revision directory: downloads fetch raw files and the
   * hashes are verified before any pipeline is built, so unverified bytes
   * never reach the ONNX parser.
   */
  createPipeline?: ((input: { modelRef: string }) => Promise<EmbeddingPipeline>) | undefined;
  /**
   * Test seam: the file hashes a valid cache must contain. Production always
   * uses the pinned EMBEDDING_MODEL_FILES.
   */
  expectedFiles?: Record<string, string> | undefined;
  /**
   * Test seam: fetches the pinned files into the cache as raw bytes, without
   * parsing them. Production downloads from the Hugging Face resolver URLs
   * for the pinned revision.
   */
  downloadModelFiles?: ((expectedFiles: Record<string, string>) => Promise<void>) | undefined;
}

/** Validates the pipeline output shape without type assertions. */
export function toVectorMatrix(value: unknown): number[][] {
  if (!Array.isArray(value)) {
    throw new Error('embedding output is not an array');
  }
  const matrix: number[][] = [];
  for (const row of value) {
    if (!Array.isArray(row) || row.length !== EMBEDDING_DIMENSIONS) {
      throw new Error('embedding row has wrong shape');
    }
    const vector: number[] = [];
    for (const component of row) {
      if (typeof component !== 'number' || !Number.isFinite(component)) {
        throw new Error('embedding row has a non-numeric component');
      }
      vector.push(component);
    }
    matrix.push(vector);
  }
  return matrix;
}

async function hashFile(filePath: string): Promise<string> {
  const data = await readFile(filePath);
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Lists files under `dir` relative to it. Returns undefined when the directory
 * is missing, unreadable, or contains anything that is not a plain file or
 * directory — symlinks, sockets, and devices fail the integrity check rather
 * than being followed.
 */
async function listPlainFiles(dir: string): Promise<string[] | undefined> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return undefined;
  }
  const found: string[] = [];
  for (const name of names) {
    const full = path.join(dir, name);
    const fileStat = await lstat(full).catch(() => undefined);
    if (fileStat === undefined || fileStat.isSymbolicLink()) {
      return undefined;
    }
    if (fileStat.isDirectory()) {
      const nested = await listPlainFiles(full);
      if (nested === undefined) {
        return undefined;
      }
      for (const entry of nested) {
        found.push(path.join(name, entry));
      }
    } else if (fileStat.isFile()) {
      found.push(name);
    } else {
      return undefined;
    }
  }
  return found;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const sharedModels = new Map<string, EmbeddingModel>();

/**
 * One model per modelDir per process: the transformers env (cache dir, remote
 * flag) is process-global, and loading the same ~120 MB twice would waste memory
 * and startup time across namespaces. The first caller's log wins.
 */
export function getSharedEmbeddingModel(options: {
  modelDir: string;
  log?: ((message: string) => void) | undefined;
}): EmbeddingModel {
  const existing = sharedModels.get(options.modelDir);
  if (existing !== undefined) {
    return existing;
  }
  const model = new EmbeddingModel({ modelDir: options.modelDir, log: options.log });
  sharedModels.set(options.modelDir, model);
  return model;
}

export class EmbeddingModel {
  private phase: EmbeddingModelPhase = 'idle';
  private unavailableReason = '';
  /** When the model last became unavailable; gates the retry in ensureReady. */
  private unavailableSinceMs = 0;
  private loadPromise: Promise<boolean> | undefined;
  private pipeline: EmbeddingPipeline | undefined;
  /** Serializes embed calls; the ONNX session gains nothing from concurrency. */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: EmbeddingModelOptions) {}

  get currentPhase(): EmbeddingModelPhase {
    return this.phase;
  }

  get failureReason(): string {
    return this.unavailableReason;
  }

  /**
   * Loads the model if needed. Concurrent callers share one load. Resolves true
   * when the model is ready; false marks it unavailable (never throws). A
   * failure latches only until UNAVAILABLE_RETRY_COOLDOWN_MS elapses — then a
   * later call retries, so transient failures recover instead of disabling
   * smart search for the rest of the process.
   */
  async ensureReady(): Promise<boolean> {
    if (this.phase === 'ready') {
      return true;
    }
    if (this.phase === 'unavailable') {
      if (Date.now() - this.unavailableSinceMs < UNAVAILABLE_RETRY_COOLDOWN_MS) {
        return false;
      }
      this.phase = 'idle';
      this.loadPromise = undefined;
      this.unavailableReason = '';
    }
    this.loadPromise ??= withTimeout(this.load(), LOAD_TIMEOUT_MS, 'embedding model load').catch(
      (error: unknown) => {
        this.markUnavailable(describeError(error));
        this.options.log?.(
          `Smart search isn't available (${this.unavailableReason}). Memories will be found with keywords.`,
        );
        return false;
      },
    );
    return this.loadPromise;
  }

  /** Single owner for the unavailable transition: phase, reason, and retry timestamp. */
  private markUnavailable(reason: string): void {
    this.phase = 'unavailable';
    this.unavailableReason = reason;
    this.unavailableSinceMs = Date.now();
  }

  async embedQueries(texts: string[]): Promise<number[][]> {
    return this.embed(texts, EMBEDDING_QUERY_PREFIX);
  }

  async embedPassages(texts: string[]): Promise<number[][]> {
    return this.embed(texts, EMBEDDING_PASSAGE_PREFIX);
  }

  private embed(texts: string[], prefix: string): Promise<number[][]> {
    const next = this.tail.then(
      async () => this.runEmbed(texts, prefix),
      async () => this.runEmbed(texts, prefix),
    );
    this.tail = next.catch(() => undefined);
    return next;
  }

  private async runEmbed(texts: string[], prefix: string): Promise<number[][]> {
    if (this.pipeline === undefined) {
      throw new Error('embedding model is not ready');
    }
    const output = await this.pipeline(
      texts.map(text => `${prefix}${text}`),
      { pooling: 'mean', normalize: true },
    );
    return toVectorMatrix(output.tolist());
  }

  private async load(): Promise<boolean> {
    this.phase = 'loading';
    const createPipeline =
      this.options.createPipeline ?? (input => defaultCreatePipeline(this.options.modelDir, input));
    const expectedFiles = this.options.expectedFiles ?? EMBEDDING_MODEL_FILES;
    const offlineModelRef = path.join(
      this.options.modelDir,
      EMBEDDING_MODEL_ID,
      EMBEDDING_MODEL_REVISION,
    );

    try {
      await mkdir(this.options.modelDir, { recursive: true });
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
      if (code !== 'EEXIST') {
        throw error;
      }
    }

    // Bring the cache to the pinned, hash-verified state first. The bytes are
    // only ever fetched and hashed here — never parsed — so a compromised
    // download cannot exploit the ONNX parser before the trust anchor rejects
    // it.
    if (!(await this.ensureVerifiedCache(expectedFiles))) {
      return false;
    }

    // One offline-load branch for pre-seeded and freshly downloaded caches:
    // allowRemoteModels stays off, so the parser only touches verified bytes.
    try {
      const extractor = await createPipeline({ modelRef: offlineModelRef });
      if (await this.canary(extractor)) {
        this.pipeline = extractor;
        this.phase = 'ready';
        return true;
      }
      this.markUnavailable(
        'The saved search model failed its self-check; keeping the verified files and staying keyword-only for now.',
      );
      this.options.log?.(this.unavailableReason);
    } catch (error) {
      this.markUnavailable(
        `The saved search model couldn't be loaded (${describeError(error)}); keeping the verified files and staying keyword-only for now.`,
      );
      this.options.log?.(this.unavailableReason);
    }
    return false;
  }

  /**
   * Makes the cache exactly the pinned file set with matching hashes,
   * downloading raw files when needed. Resolves false (after marking the
   * model unavailable) when the cache cannot be brought to a trusted state.
   */
  private async ensureVerifiedCache(expectedFiles: Record<string, string>): Promise<boolean> {
    if (await verifyModelFiles(this.options.modelDir, expectedFiles)) {
      return true;
    }
    const downloadModelFiles =
      this.options.downloadModelFiles ??
      (files => downloadPinnedModelFiles({ modelDir: this.options.modelDir, expectedFiles: files }));
    // A structurally wrong cache (stray files, symlinks, special files) can
    // never become valid by overwriting pinned paths: wipe it so the download
    // starts from a clean directory.
    if (await hasStructuralMismatch(this.options.modelDir, expectedFiles)) {
      await wipeModelDir(this.options.modelDir);
    }
    // The eval saw one transient Hugging Face failure: retry once, then degrade.
    this.noteDownloading();
    let lastError: unknown;
    let downloadCompleted = false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (attempt > 0) {
        await sleep(DOWNLOAD_RETRY_DELAY_MS);
      }
      try {
        await downloadModelFiles(expectedFiles);
        downloadCompleted = true;
      } catch (error) {
        lastError = error;
        continue;
      }
      if (await verifyModelFiles(this.options.modelDir, expectedFiles)) {
        return true;
      }
      lastError = new Error('the downloaded model failed its integrity check');
    }
    // Fresh bytes still fail verification: the source is hostile or the disk
    // is failing. Wipe so a later retry starts clean instead of re-hashing
    // poisoned bytes forever, then degrade to keyword-only. A pure download
    // failure leaves nothing behind, so there is nothing to wipe.
    if (downloadCompleted) {
      await wipeModelDir(this.options.modelDir);
    }
    this.markUnavailable(
      downloadCompleted
        ? `the model download failed its integrity check twice (${describeError(lastError)}); cleared the model cache and staying keyword-only for now`
        : `the model download failed twice (${describeError(lastError)}); staying keyword-only for now`,
    );
    this.options.log?.(
      `Smart search isn't available (${this.unavailableReason}). Memories will be found with keywords.`,
    );
    return false;
  }

  private noteDownloading(): void {
    if (this.phase !== 'downloading') {
      this.phase = 'downloading';
      this.options.log?.(
        `Downloading the memory search model once (${EMBEDDING_MODEL_DOWNLOAD_SIZE}). This happens in the background; memory search keeps working with keywords until it finishes.`,
      );
    }
  }

  /** The model must return 384 finite, unit-norm components for fixed input. */
  private async canary(extractor: EmbeddingPipeline): Promise<boolean> {
    try {
      const output = await extractor([`${EMBEDDING_PASSAGE_PREFIX}${CANARY_TEXT}`], {
        pooling: 'mean',
        normalize: true,
      });
      const matrix = toVectorMatrix(output.tolist());
      const vector = matrix[0];
      if (vector === undefined) {
        return false;
      }
      let norm = 0;
      for (const component of vector) {
        norm += component * component;
      }
      norm = Math.sqrt(norm);
      return norm > 0.99 && norm < 1.01;
    } catch {
      return false;
    }
  }
}

/**
 * The exact cache layout a trusted model directory must have: every pinned
 * file at its revision path with its hash, plus the redundant config.json
 * transformers.js keeps one level above the revision dir (trusted only when
 * its hash matches the pinned config).
 */
function trustedFileSet(expectedFiles: Record<string, string>): {
  required: Map<string, string>;
  redundantConfig: string;
} {
  const required = new Map<string, string>();
  for (const [relative, hash] of Object.entries(expectedFiles)) {
    required.set(path.join(EMBEDDING_MODEL_ID, EMBEDDING_MODEL_REVISION, relative), hash);
  }
  return { required, redundantConfig: path.join(EMBEDDING_MODEL_ID, 'config.json') };
}

/**
 * True when the whole `modelDir` tree holds exactly the trusted files.
 * Anything else — extra files, missing files, mismatched hashes, symlinks,
 * or special files anywhere under the cache — fails the check.
 */
export async function verifyModelFiles(
  modelDir: string,
  expectedFiles: Record<string, string>,
): Promise<boolean> {
  const seen = await listPlainFiles(modelDir);
  if (seen === undefined) {
    return false;
  }
  const { required, redundantConfig } = trustedFileSet(expectedFiles);
  const redundantHash = expectedFiles['config.json'];
  let matched = 0;
  for (const relative of seen) {
    const want = required.get(relative);
    if (want !== undefined) {
      const actual = await hashFile(path.join(modelDir, relative)).catch(() => undefined);
      if (actual !== want) {
        return false;
      }
      matched += 1;
      continue;
    }
    if (relative === redundantConfig && redundantHash !== undefined) {
      const actual = await hashFile(path.join(modelDir, relative)).catch(() => undefined);
      if (actual !== redundantHash) {
        return false;
      }
      continue;
    }
    return false;
  }
  return matched === required.size;
}

/**
 * True when the cache can never become trusted by overwriting pinned paths:
 * it is unreadable, or holds files outside the trusted set (stray files,
 * symlinks, special files). Hash mismatches on pinned paths are NOT
 * structural — a fresh download can repair them.
 */
async function hasStructuralMismatch(
  modelDir: string,
  expectedFiles: Record<string, string>,
): Promise<boolean> {
  const seen = await listPlainFiles(modelDir);
  if (seen === undefined) {
    return true;
  }
  const { required, redundantConfig } = trustedFileSet(expectedFiles);
  return seen.some(relative => !required.has(relative) && relative !== redundantConfig);
}

/**
 * Removes the whole model cache. Guarded against catastrophic paths: only
 * ever wipes below the filesystem root.
 */
async function wipeModelDir(modelDir: string): Promise<void> {
  const resolved = path.resolve(modelDir);
  if (resolved === path.parse(resolved).root) {
    return;
  }
  await rm(modelDir, { recursive: true, force: true });
}

/** Options for downloadPinnedModelFiles. */
export interface DownloadPinnedModelFilesOptions {
  modelDir: string;
  expectedFiles: Record<string, string>;
  /** Test seam: defaults to the global fetch. */
  fetchImpl?: typeof fetch | undefined;
  /** Test seam: per-file byte cap. Production uses MAX_DOWNLOAD_FILE_BYTES. */
  maxBytes?: number | undefined;
}

/**
 * Downloads the pinned files for the pinned revision as raw bytes — fetched
 * and written, never parsed. Each file lands via temp-file + rename so a
 * partial download never looks complete, and bodies are size-bounded so a
 * hostile server cannot blow up process memory. The caller must run
 * verifyModelFiles before the bytes are used.
 */
export async function downloadPinnedModelFiles(
  options: DownloadPinnedModelFilesOptions,
): Promise<void> {
  const revisionDir = path.join(options.modelDir, EMBEDDING_MODEL_ID, EMBEDDING_MODEL_REVISION);
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxBytes = options.maxBytes ?? MAX_DOWNLOAD_FILE_BYTES;
  for (const relative of Object.keys(options.expectedFiles)) {
    const url = `https://huggingface.co/${EMBEDDING_MODEL_ID}/resolve/${EMBEDDING_MODEL_REVISION}/${relative}`;
    const target = path.join(revisionDir, relative);
    await mkdir(path.dirname(target), { recursive: true });
    const response = await fetchImpl(url);
    if (!response.ok) {
      throw new Error(`model file download failed: ${url} -> HTTP ${String(response.status)}`);
    }
    const bytes = await readBoundedBody(response, maxBytes, url);
    // Staged under a dotfile so an interrupted write is never mistaken for
    // the pinned file, then moved into place. rename(2) cannot replace an
    // existing file on Windows (EPERM), so remove the target first; a crash
    // between rm and rename fails closed (verifyModelFiles rejects the
    // missing file and the download is retried).
    const staging = path.join(path.dirname(target), `.${path.basename(target)}.part`);
    await writeFile(staging, bytes, { mode: 0o600 });
    await rm(target, { force: true });
    await rename(staging, target);
  }
}

/** Reads a fetch body with a hard byte cap; a lying content-length can't bypass it. */
async function readBoundedBody(response: Response, maxBytes: number, url: string): Promise<Buffer> {
  const declared = response.headers.get('content-length');
  if (declared !== null) {
    const declaredBytes = Number(declared);
    if (!Number.isFinite(declaredBytes) || declaredBytes > maxBytes) {
      throw new Error(`model file too large: ${url}`);
    }
  }
  const body = response.body;
  if (body === null) {
    throw new Error(`model file download returned no body: ${url}`);
  }
  const reader: ReadableStreamDefaultReader<Uint8Array> = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`model file too large: ${url}`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** Production pipeline builder: offline only, from the verified revision directory. */
async function defaultCreatePipeline(
  modelDir: string,
  input: { modelRef: string },
): Promise<EmbeddingPipeline> {
  // Imported lazily: transformers.js pulls in sharp and the onnxruntime native
  // binding at module load, which would tax every server boot (and every unit
  // test run) even when embeddings are disabled. The module is only needed
  // when a pipeline is actually built.
  const { env, pipeline } = await import('@huggingface/transformers');
  // transformers.js env is process-global; the shared model (one per modelDir)
  // is the only writer. The cache is hash-verified before this runs, so stay
  // offline: the parser only ever touches pinned bytes.
  env.cacheDir = modelDir;
  env.allowRemoteModels = false;
  // Offline loads take the local revision directory directly: with
  // allowRemoteModels=false transformers.js resolves model ids against
  // env.localModelPath (no revision), never finding the pinned cache. A local
  // path loads only from these exact files, with no network by construction.
  try {
    const real = await pipeline('feature-extraction', input.modelRef, { dtype: 'q8' });
    // Adapt the real pipeline to the narrow shape this module uses.
    const narrow: EmbeddingPipeline = (texts, options) =>
      real(texts, options).then(tensor => ({ tolist: (): unknown => tensor.tolist() }));
    return narrow;
  } catch (error) {
    throw new Error('the saved model could not be loaded', { cause: error });
  }
}

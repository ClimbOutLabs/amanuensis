/**
 * Lazy loader for the on-device embedding model behind meaning-based recall.
 * The model is pinned (id + HF revision + SHA-256 of every file) because
 * retrieval quality depends on the exact evaluated model. Nothing is ever
 * downloaded: the images ship the pinned files, and other installs copy them
 * in by hand. The file set and hashes are verified first, and only then is the
 * pipeline instantiated offline — so unverified bytes never reach the ONNX
 * parser. Every failure degrades to keyword-only. A unit-norm canary guards
 * against a corrupt-but-present model folder.
 */
import { withTimeout } from '@truefoundry/trueforge-core/core';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { ensureWritableDataDir } from '../../utils/dataDir';

/** Pinned by the retrieval eval; do not change without re-running the eval. */
export const EMBEDDING_MODEL_ID = 'Xenova/multilingual-e5-small';
export const EMBEDDING_MODEL_REVISION = '761b726dd34fb83930e26aab4e9ac3899aa1fa78';
export const EMBEDDING_DIMENSIONS = 384;
/** E5 requires these prefixes; the embed methods apply them unconditionally. */
export const EMBEDDING_QUERY_PREFIX = 'query: ';
export const EMBEDDING_PASSAGE_PREFIX = 'passage: ';

/**
 * Trust anchor: SHA-256 of every file the pinned revision must contain, measured
 * 2026-09-20. Do not change without re-running the retrieval eval.
 */
export const EMBEDDING_MODEL_FILES: Record<string, string> = {
  'config.json': 'cb99455288675345e1a4f411438d5d0adbba5fbd3a67ea4fb03c015433b996c1',
  'tokenizer.json': '0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39',
  'tokenizer_config.json': 'a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b',
  'onnx/model_quantized.onnx': 'f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193',
};

const CANARY_TEXT = 'the quick brown fox jumps over the lazy dog';
/** Generous: hashing the files and warming the model on a slow machine. */
const LOAD_TIMEOUT_MS = 5 * 60 * 1000;
/**
 * How long an 'unavailable' model stays latched before a later ensureReady()
 * retries the load. Matches the warm retry cooldown in embeddingRetrieval, so
 * a transient failure (locked file, brief I/O error) recovers on a later turn
 * instead of disabling smart search for the process.
 */
const UNAVAILABLE_RETRY_COOLDOWN_MS = 60_000;

export type EmbeddingModelPhase = 'idle' | 'loading' | 'ready' | 'unavailable';

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
   * the verified local revision directory: the hashes are verified before any
   * pipeline is built, so unverified bytes never reach the ONNX parser.
   */
  createPipeline?: ((input: { modelRef: string }) => Promise<EmbeddingPipeline>) | undefined;
  /**
   * Test seam: the file hashes a valid cache must contain. Production always
   * uses the pinned EMBEDDING_MODEL_FILES.
   */
  expectedFiles?: Record<string, string> | undefined;
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

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const sharedModels = new Map<string, EmbeddingModel>();

/**
 * Synchronous, cheap check that the pinned model files are present on disk.
 * Existence only — hashes are verified inside `ensureReady()` before anything
 * is parsed. Used to decide whether a nonblocking warm is worth starting.
 */
export function isEmbeddingModelCached(modelDir: string): boolean {
  const revisionDir = path.join(modelDir, EMBEDDING_MODEL_ID, EMBEDDING_MODEL_REVISION);
  return Object.keys(EMBEDDING_MODEL_FILES).every(file => existsSync(path.join(revisionDir, file)));
}

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
    this.loadPromise ??= withTimeout(this.load(), LOAD_TIMEOUT_MS, 'embedding model load').catch((error: unknown) => {
      this.markUnavailable(describeError(error));
      this.options.log?.(
        `Smart search isn't available (${this.unavailableReason}). Memories will be found with keywords.`,
      );
      return false;
    });
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
    const offlineModelRef = path.join(this.options.modelDir, EMBEDDING_MODEL_ID, EMBEDDING_MODEL_REVISION);

    // Names MEMORY_EMBEDDINGS_MODEL_DIR in the error instead of a bare EACCES.
    await ensureWritableDataDir({
      dir: this.options.modelDir,
      envVar: 'MEMORY_EMBEDDINGS_MODEL_DIR',
    });

    // The files are hashed before anything parses them, so tampered bytes
    // never reach the ONNX parser.
    if (!(await this.ensureVerifiedFiles(expectedFiles))) {
      return false;
    }

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
   * True when the model folder holds exactly the pinned files with matching
   * hashes. Nothing is downloaded: a missing or changed file leaves memory
   * search on keywords, with a reason that says where the files go.
   */
  private async ensureVerifiedFiles(expectedFiles: Record<string, string>): Promise<boolean> {
    if (await verifyModelFiles(this.options.modelDir, expectedFiles)) {
      return true;
    }
    this.markUnavailable(
      `the memory search model is missing from ${this.options.modelDir}, or its files do not match the pinned ones. Copy the model files there as the memory guide describes, then restart Aman`,
    );
    this.options.log?.(
      `Smart search isn't available (${this.unavailableReason}). Memories will be found with keywords.`,
    );
    return false;
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
export async function verifyModelFiles(modelDir: string, expectedFiles: Record<string, string>): Promise<boolean> {
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

/** Production pipeline builder: offline only, from the verified revision directory. */
async function defaultCreatePipeline(modelDir: string, input: { modelRef: string }): Promise<EmbeddingPipeline> {
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

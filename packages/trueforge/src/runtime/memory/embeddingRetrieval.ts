/**
 * Meaning-based recall for the markdown memory backend. When the vector leg
 * cannot contribute — model still downloading, backfill incomplete, no peaked
 * signal, or any error — it degrades to "not available" and recall behaves
 * exactly as it did before embeddings existed. A peak gate (top-1 similarity
 * minus the corpus mean) rejects flat score distributions; peaked vector hits
 * lead the ranking and keyword hits only append ids the vector leg missed.
 */
import { PromiseTimeoutError, withTimeout } from '@truefoundry/trueforge-core/core';
import path from 'node:path';
import { EMBEDDING_DIMENSIONS, getSharedEmbeddingModel, type EmbeddingModel } from './embeddingModel';
import { EmbeddingStore, hashEntryText } from './embeddingStore';
import { namespaceDirFor, scanNamespaceEntries } from './markdownMemoryFiles';

/** How many vector hits lead the ranking; bounded work per recall. */
export const VECTOR_TOP_K = 50;
/**
 * Minimum (top-1 similarity − mean similarity of the rest) for the vector leg
 * to count. Measured on the eval golden set: 21 real queries peaked 0.061..0.144,
 * 3 junk probes peaked 0.036..0.054. A guard, not a guarantee — corpus-dependent.
 */
export const VECTOR_PEAK_THRESHOLD = 0.06;
/**
 * Absolute top-1 similarity that bypasses the peak gate — but only in small
 * corpora (see SMALL_CORPUS_BYPASS_MAX). In small homogeneous corpora every
 * entry scores high, so the peak can be tiny even for a strong match; a top
 * score this high is confident on its own. Measured Sep 20, 2026: the eval's
 * junk probes scored 0.793-0.816 on the 48-entry golden corpus, overlapping
 * relevant queries at 0.808-0.909, so no absolute floor can separate them at
 * scale — the bypass must not apply there. But in the small-corpus journey
 * (3 entries) valid queries score 0.81+ with peaks below 0.06. This is a
 * pragmatic tradeoff for small corpora where keyword search is the primary
 * fallback anyway.
 */
export const VECTOR_CONFIDENCE_THRESHOLD = 0.8;
/**
 * Largest corpus the confidence bypass applies to. Measured Sep 20, 2026:
 * junk queries reach 0.816 top-1 even against 3-entry subsets (max over
 * trials), but the median junk max stays under 0.8 up to ~10 entries and the
 * real journey needed the bypass at 3 entries, while at 48 entries the peak
 * gate alone passes all 21 real queries (peaks 0.061..0.144) and rejects all
 * junk (peaks 0.036..0.054). So: at most this many entries the bypass rescues
 * flat-but-strong matches; above it the peak gate governs.
 */
const SMALL_CORPUS_BYPASS_MAX = 10;
/**
 * Backfill persists this often; a crash redoes at most this many batches.
 * Each save re-encodes the whole store, so total write volume scales
 * quadratically (~N^2/800 entry-encodings); fine at the measured 5k-entry
 * scale (~86 s), revisit if corpora grow 10x.
 */
const BACKFILL_SAVE_EVERY_BATCHES = 10;
/** Cooldown before a failed background warm is retried, so a persistent failure doesn't hot-loop. */
export const WARM_RETRY_COOLDOWN_MS = 60_000;
/**
 * A successful warm goes stale after this long: the next turn re-warms, so
 * out-of-band edits and deletions are reconciled without rescanning on every
 * turn. The re-warm only re-embeds changed entries.
 */
const WARM_STALE_AFTER_MS = 10 * 60_000;
/**
 * The vector leg stays off below two indexed entries. Measured Sep 20, 2026:
 * junk queries score 0.793-0.816 absolute on top-1, overlapping relevant
 * queries at 0.808-0.909, so no absolute floor can separate them; and with a
 * single entry the peak gate is identically zero. Keyword search is
 * near-perfect at this size, so nothing is lost.
 */
const MIN_CORPUS_FOR_VECTOR_RANK = 2;
/**
 * Fallback when a fusedRank caller passes a non-finite timeout: without this,
 * Math.max(undefined, 1) is NaN and withTimeout degrades to a 1 ms silent
 * timeout, making the vector leg fail vacuously instead of firing.
 */
const FUSED_RANK_DEFAULT_TIMEOUT_MS = 30_000;

export function cosineSimilarity({ a, b }: { a: ArrayLike<number>; b: ArrayLike<number> }): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** True when the best score stands out from the corpus baseline. */
export function passesPeakGate(similarities: number[]): boolean {
  if (similarities.length < 2) {
    return false;
  }
  let top = -Infinity;
  let sum = 0;
  for (const similarity of similarities) {
    if (similarity > top) {
      top = similarity;
    }
    sum += similarity;
  }
  // A very high absolute score is confident on its own — but only in small
  // corpora: in small homogeneous corpora the rest also score high, which
  // shrinks the peak below the threshold even for a correct top hit. At
  // scale junk queries reach 0.8+ too, so the bypass must not apply there.
  if (similarities.length <= SMALL_CORPUS_BYPASS_MAX && top >= VECTOR_CONFIDENCE_THRESHOLD) {
    return true;
  }
  // The top hit must not count toward its own baseline: including it drags the
  // mean up, which systematically hides peaks in small corpora.
  const restMean = (sum - top) / (similarities.length - 1);
  return top - restMean >= VECTOR_PEAK_THRESHOLD;
}

export function rankByCosine(
  query: ArrayLike<number>,
  candidates: { id: string; vector: ArrayLike<number> }[],
): { id: string; similarity: number }[] {
  return candidates
    .map(candidate => ({ id: candidate.id, similarity: cosineSimilarity({ a: query, b: candidate.vector }) }))
    .sort((a, b) => b.similarity - a.similarity);
}

/**
 * Vector-first ordering: peaked vector hits lead (the eval showed vector-only
 * ranking beats fusing with keywords); keyword hits only append ids the vector
 * leg missed, as degradation coverage.
 */
export function orderVectorFirst({
  vectorOrder,
  keywordOrder,
}: {
  vectorOrder: string[];
  keywordOrder: string[];
}): string[] {
  const seen = new Set(vectorOrder);
  const ordered = [...vectorOrder];
  for (const id of keywordOrder) {
    if (!seen.has(id)) {
      seen.add(id);
      ordered.push(id);
    }
  }
  return ordered;
}

export type EmbeddingSubsystemState = 'starting' | 'downloading' | 'backfilling' | 'ready' | 'unavailable';

export interface EmbeddingStatus {
  state: EmbeddingSubsystemState;
  /** Plain-English status; safe to show in UI or logs. */
  detail: string;
  indexedEntries: number;
}

export interface EmbeddingSubsystemOptions {
  baseDir: string;
  namespace: string;
  modelDir: string;
  batchSize: number;
  log?: ((message: string) => void) | undefined;
  /** Injectable for tests; production shares one model per `modelDir`. */
  model?: EmbeddingModel | undefined;
}

export interface RankedMemory {
  id: string;
  text: string;
}

function defaultBatchSize(batchSize: number): number {
  return Number.isInteger(batchSize) && batchSize > 0 ? batchSize : 8;
}

/**
 * One model per modelDir per process (see `getSharedEmbeddingModel`); the
 * subsystem itself stays per-namespace because the vector cache is namespaced.
 */
function sharedModel(options: EmbeddingSubsystemOptions): EmbeddingModel {
  if (options.model !== undefined) {
    return options.model;
  }
  return getSharedEmbeddingModel({ modelDir: options.modelDir, log: options.log });
}

export class EmbeddingSubsystem {
  private readonly model: EmbeddingModel;
  private readonly batchSize: number;
  private readonly log?: ((message: string) => void) | undefined;
  private store: EmbeddingStore | undefined;
  private warmPromise: Promise<void> | undefined;
  private lastWarmAttemptMs = 0;
  private lastWarmSuccessMs = 0;
  private backfillRunning = false;
  /** Serializes backfill vs incremental indexing: one store writer at a time. */
  private storeQueue: Promise<void> = Promise.resolve();
  private backfillTotal = 0;
  private backfillDone = 0;
  private lastLoggedDetail = '';
  /**
   * The one pending automatic retry after a failed warm, if any. Unref'd so a
   * quiet server can still exit; cleared whenever a fresh warm attempt starts
   * so the chain can never go silent.
   */
  private retryTimer: NodeJS.Timeout | undefined;

  constructor(private readonly options: EmbeddingSubsystemOptions) {
    this.batchSize = defaultBatchSize(options.batchSize);
    this.log = options.log;
    this.model = sharedModel(options);
  }

  getStatus(): EmbeddingStatus {
    const indexedEntries = this.store?.size ?? 0;
    const phase = this.model.currentPhase;
    if (phase === 'unavailable') {
      // Plain-English on purpose: failureReason carries raw errno text and
      // absolute paths for the server log — never for the Settings screen.
      // The model retries on its own after the cooldown, so this is honest.
      return {
        state: 'unavailable',
        detail:
          "Smart search isn't available right now — trying again automatically. Memories are found with keywords meanwhile.",
        indexedEntries,
      };
    }
    if (phase === 'ready' && (this.store?.isBackfilled ?? false) && !this.backfillRunning) {
      return {
        state: 'ready',
        detail: 'Smart search is on — memories are found by meaning as well as keywords.',
        indexedEntries,
      };
    }
    if (phase === 'downloading') {
      return {
        state: 'downloading',
        detail:
          'Downloading the memory search model once (about 120 MB) in the background. Memory search keeps working with keywords until it finishes.',
        indexedEntries,
      };
    }
    if (this.backfillRunning || this.store !== undefined) {
      const total = Math.max(this.backfillTotal, 1);
      return {
        state: 'backfilling',
        detail: `Smart search is indexing your memories (${String(this.backfillDone)} of ${String(total)}). Keyword search works meanwhile.`,
        indexedEntries,
      };
    }
    return {
      state: 'starting',
      detail: 'Smart search is starting.',
      indexedEntries,
    };
  }

  /** Fire-and-forget; safe to call on every turn. Starts load, then backfill, once. */
  ensureWarmed(): void {
    if (this.warmPromise !== undefined) {
      return;
    }
    // A successful warm goes stale: re-warm on a later turn so out-of-band
    // edits and deletions are reconciled without rescanning every turn.
    if (this.lastWarmSuccessMs > 0 && Date.now() - this.lastWarmSuccessMs < WARM_STALE_AFTER_MS) {
      return;
    }
    // A failed warm retries after the cooldown (automatically, via the retry
    // timer below, and on a later turn), so a transient disk error doesn't
    // permanently disable the vector leg for the process.
    if (Date.now() - this.lastWarmAttemptMs < WARM_RETRY_COOLDOWN_MS) {
      return;
    }
    this.lastWarmAttemptMs = Date.now();
    // A fresh attempt supersedes any pending automatic retry: leaving it armed
    // would let it fire inside the new attempt's cooldown, get gated, and
    // silently end the retry chain.
    this.clearRetry();
    this.warmPromise = this.warm().then(
      warmed => {
        this.warmPromise = undefined;
        // Only a warm that actually backfilled counts as success: a failed
        // warm must stay on the short retry cooldown, not the 10-minute
        // stale timer, or a persistent failure would look "freshly warmed".
        if (warmed) {
          this.lastWarmSuccessMs = Date.now();
        } else {
          this.scheduleRetry();
        }
      },
      (error: unknown) => {
        this.warmPromise = undefined;
        this.log?.(
          `Smart search background work hit a problem (${error instanceof Error ? error.message : String(error)}); will retry automatically.`,
        );
        this.scheduleRetry();
      },
    );
  }

  /**
   * Arms the one automatic retry after a failed warm. At most one retry is ever
   * pending; when it fires it goes back through `ensureWarmed`, so the cooldown
   * gate still bounds the attempt rate and a persistent failure retries about
   * once a minute instead of hot-looping. The timer is unref'd so it never
   * holds the server process open on its own. This is what makes "trying again
   * automatically" honest even when no chat turn ever calls `ensureWarmed`.
   */
  private scheduleRetry(): void {
    if (this.retryTimer !== undefined) {
      return;
    }
    const timer = setTimeout(() => {
      this.retryTimer = undefined;
      this.ensureWarmed();
    }, WARM_RETRY_COOLDOWN_MS);
    // A pending retry must never keep the server process alive on its own.
    // Guarded rather than assumed: timer fakes in tests may not implement it.
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
    this.retryTimer = timer;
  }

  private clearRetry(): void {
    if (this.retryTimer !== undefined) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
  }

  /** Runs store mutations one at a time: backfill and incremental indexing share the store. */
  private queueStoreMutation(task: () => Promise<void>): Promise<void> {
    const run = this.storeQueue.then(task, task);
    this.storeQueue = run.catch(() => undefined);
    return run;
  }

  /**
   * Hybrid rank for recall. Returns fused `{id, text}` best-first, or `undefined`
   * when the vector leg cannot contribute — the caller then ranks by keywords
   * exactly as before. Never throws. Keyword hits carry their freshly scanned
   * text; vector-only hits carry the indexed text.
   */
  async fusedRank(input: {
    query: string;
    keywordHits: RankedMemory[];
    /** Live id → text from the caller's fresh scan; vector hits resolve here. */
    entryTexts: Map<string, string>;
    /** Query-embedding budget; falls back to FUSED_RANK_DEFAULT_TIMEOUT_MS when absent. */
    timeoutMs?: number;
  }): Promise<RankedMemory[] | undefined> {
    try {
      // Never block recall on a download: unless the model is already ready,
      // kick the background warm and fall back to keywords immediately.
      if (this.model.currentPhase !== 'ready') {
        this.ensureWarmed();
        return undefined;
      }
      const store = this.store;
      if (!store?.isBackfilled) {
        this.ensureWarmed();
        return undefined;
      }
      const ids = store.ids();
      if (ids.length < MIN_CORPUS_FOR_VECTOR_RANK) {
        // With fewer than two entries the peak gate has no distribution to
        // measure against, and keyword search is near-perfect at this size;
        // the vector leg activates as the corpus grows.
        return undefined;
      }
      const timeoutMs =
        typeof input.timeoutMs === 'number' && Number.isFinite(input.timeoutMs) && input.timeoutMs > 0
          ? input.timeoutMs
          : FUSED_RANK_DEFAULT_TIMEOUT_MS;
      const queryVectors = await withTimeout(
        this.model.embedQueries([input.query]),
        // Guard the boundary: a missing/NaN timeout must not become a silent
        // 1 ms timeout (setTimeout(NaN) warns and fires almost immediately).
        timeoutMs,
        'memory embedding query',
      );
      const queryVector = queryVectors[0];
      if (queryVector?.length !== EMBEDDING_DIMENSIONS) {
        return undefined;
      }
      const candidates: { id: string; vector: ArrayLike<number> }[] = [];
      for (const id of ids) {
        const entry = store.get(id);
        if (entry !== undefined) {
          candidates.push({ id, vector: entry.vector });
        }
      }
      const ranked = rankByCosine(queryVector, candidates);
      if (!passesPeakGate(ranked.map(hit => hit.similarity))) {
        return undefined;
      }
      const vectorOrder = ranked.slice(0, VECTOR_TOP_K).map(hit => hit.id);
      const keywordOrder = input.keywordHits.map(hit => hit.id);
      const fused = orderVectorFirst({ vectorOrder, keywordOrder });
      const results: RankedMemory[] = [];
      for (const id of fused) {
        // Text comes only from the live scan: the store keeps vectors and
        // hashes, never plaintext, so a deleted memory cannot resurface here.
        const text = input.entryTexts.get(id);
        if (text !== undefined) {
          results.push({ id, text });
        }
      }
      // A fused id missing from the live scan means the store and the scan
      // disagree; warm again so the next pass reconciles.
      if (results.length < fused.length) {
        this.ensureWarmed();
      }
      return results;
    } catch (error) {
      if (!(error instanceof PromiseTimeoutError)) {
        this.log?.(
          `Smart search hit a problem (${error instanceof Error ? error.message : String(error)}); using keyword search for this recall.`,
        );
      }
      return undefined;
    }
  }

  /** Fire-and-forget incremental indexing after a retain; backfill covers the rest. */
  indexNewEntries(entries: RankedMemory[]): void {
    if (entries.length === 0) {
      return;
    }
    void this.queueStoreMutation(() => this.indexEntries(entries)).catch((error: unknown) => {
      this.log?.(
        `Smart search couldn't index ${String(entries.length)} new memories (${error instanceof Error ? error.message : String(error)}); the next warm will retry.`,
      );
    });
  }

  private async indexEntries(entries: RankedMemory[]): Promise<void> {
    const store = this.store;
    if (store === undefined || !(await this.model.ensureReady())) {
      return;
    }
    const pending = entries.filter(entry => {
      const existing = store.get(entry.id);
      return existing?.hash !== hashEntryText(entry.text);
    });
    if (pending.length === 0) {
      return;
    }
    for (let i = 0; i < pending.length; i += this.batchSize) {
      const batch = pending.slice(i, i + this.batchSize);
      const vectors = await this.model.embedPassages(batch.map(entry => entry.text));
      for (let k = 0; k < batch.length; k++) {
        const entry = batch[k];
        const vector = vectors[k];
        if (entry !== undefined && vector !== undefined) {
          store.set({ id: entry.id, text: entry.text, vector });
        }
      }
      await store.save();
    }
  }

  private async warm(): Promise<boolean> {
    const ready = await this.model.ensureReady();
    if (!ready) {
      return false;
    }
    // The store loads and backfills on the same single writer as incremental
    // indexing, so a periodic reload can never clobber a concurrent update.
    // A failed reload keeps the previous store serving and reports failure, so
    // the retry stays on the short cooldown instead of the 10-minute timer.
    let warmed = false;
    await this.queueStoreMutation(async () => {
      this.store = await EmbeddingStore.load({ namespaceDir: this.namespaceDir() });
      await this.backfill();
      warmed = this.store.isBackfilled;
    });
    return warmed;
  }

  private namespaceDir(): string {
    return namespaceDirFor(this.options.baseDir, this.options.namespace);
  }

  private async backfill(): Promise<void> {
    if (this.backfillRunning) {
      return;
    }
    const store = this.store;
    if (store === undefined) {
      return;
    }
    this.backfillRunning = true;
    try {
      const scan = await scanNamespaceEntries({
        baseDir: this.options.baseDir,
        namespace: this.options.namespace,
        maxDailyFiles: Number.POSITIVE_INFINITY,
        // Vault deletes drop entries from the live id set so reconcile clears
        // their vectors; vault edits change the text so the hash check re-embeds.
        resolveTombstones: true,
      });
      const liveIds = new Set(scan.entries.map(entry => entry.id));
      if (store.reconcile(liveIds)) {
        await store.save();
      }
      const pending = scan.entries.filter(entry => {
        const existing = store.get(entry.id);
        return existing?.hash !== hashEntryText(entry.text);
      });
      this.backfillTotal = pending.length;
      this.backfillDone = 0;
      if (pending.length > 0) {
        this.announce(
          `Smart search is indexing ${String(pending.length)} ${pending.length === 1 ? 'memory' : 'memories'} in the background. Keyword search works meanwhile.`,
        );
      }
      let batchesSinceSave = 0;
      for (let i = 0; i < pending.length; i += this.batchSize) {
        const batch = pending.slice(i, i + this.batchSize);
        const vectors = await this.model.embedPassages(batch.map(entry => entry.text));
        for (let k = 0; k < batch.length; k++) {
          const entry = batch[k];
          const vector = vectors[k];
          if (entry !== undefined && vector !== undefined) {
            store.set({ id: entry.id, text: entry.text, vector });
          }
        }
        batchesSinceSave += 1;
        if (batchesSinceSave >= BACKFILL_SAVE_EVERY_BATCHES) {
          await store.save();
          batchesSinceSave = 0;
        }
        this.backfillDone = Math.min(i + this.batchSize, pending.length);
        // Yield between batches: the backfill must never starve the event loop.
        await new Promise(resolve => setImmediate(resolve));
      }
      store.markBackfilled();
      await store.save();
      this.announce('Smart search finished indexing your memories.');
    } finally {
      this.backfillRunning = false;
    }
  }

  private announce(detail: string): void {
    if (this.lastLoggedDetail !== detail) {
      this.lastLoggedDetail = detail;
      this.log?.(detail);
    }
  }
}

/** Picks the subsystem for one vault namespace; each vault keeps its own embedding store. */
export type EmbeddingSubsystemResolver = (namespace: string) => EmbeddingSubsystem;

const subsystems = new Map<string, EmbeddingSubsystem>();

/**
 * Default model cache: inside the markdown dir so it rides the same persistent
 * volume as the memories themselves and survives container recreates.
 */
export function defaultEmbeddingModelDir(markdownDir: string): string {
  return path.join(markdownDir, '.embedding-model');
}

/**
 * Process-wide singleton: the model loads once no matter how many turns construct
 * memory clients. Keyed by baseDir/namespace/modelDir.
 */
export function getEmbeddingSubsystem(options: EmbeddingSubsystemOptions): EmbeddingSubsystem {
  const key = `${options.baseDir}::${options.namespace}::${options.modelDir}`;
  const existing = subsystems.get(key);
  if (existing !== undefined) {
    return existing;
  }
  const subsystem = new EmbeddingSubsystem(options);
  subsystems.set(key, subsystem);
  return subsystem;
}

/**
 * Single owner for the boot-time warm: kicks the background warm for one namespace's
 * embedding subsystem at server startup. The shared model download starts immediately
 * instead of on first use, and the namespace's memories index once it is ready.
 * Fire-and-forget — startup never waits; a failure degrades to keyword search with
 * the usual cooldown retry.
 */
export function warmEmbeddingsAtBoot(options: EmbeddingSubsystemOptions): void {
  getEmbeddingSubsystem(options).ensureWarmed();
}

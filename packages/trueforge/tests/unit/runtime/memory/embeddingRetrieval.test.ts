import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  EMBEDDING_DIMENSIONS,
  EmbeddingModel,
  getSharedEmbeddingModel,
  type EmbeddingModelPhase,
  type EmbeddingPipeline,
} from '../../../../src/runtime/memory/embeddingModel';
import {
  EmbeddingSubsystem,
  WARM_RETRY_COOLDOWN_MS,
  cosineSimilarity,
  getEmbeddingSubsystem,
  orderVectorFirst,
  passesPeakGate,
  rankByCosine,
  warmEmbeddingsAtBoot,
  type EmbeddingSubsystemState,
} from '../../../../src/runtime/memory/embeddingRetrieval';
import { MarkdownMemoryClient } from '../../../../src/runtime/memory/markdownMemoryClient';

function oneHot(index: number): number[] {
  const values = new Array(EMBEDDING_DIMENSIONS).fill(0);
  values[index % EMBEDDING_DIMENSIONS] = 1;
  return values;
}

class FakeEmbeddingModel extends EmbeddingModel {
  ready = true;
  phaseOverride: EmbeddingModelPhase | undefined;
  blockEnsureReady = false;
  embedGate: (() => Promise<void>) | undefined;
  queryVector: number[] = oneHot(0);
  vectorForText: (text: string) => number[] = () => oneHot(1);
  embeddedPassageTexts: string[][] = [];

  constructor() {
    super({ modelDir: path.join(tmpdir(), 'fake-embedding-model') });
  }

  override get currentPhase(): EmbeddingModelPhase {
    return this.phaseOverride ?? (this.ready ? 'ready' : 'unavailable');
  }

  override get failureReason(): string {
    return 'fake model unavailable';
  }

  override async ensureReady(): Promise<boolean> {
    if (this.blockEnsureReady) {
      await new Promise<void>(() => undefined);
    }
    return this.ready;
  }

  override async embedQueries(texts: string[]): Promise<number[][]> {
    return texts.map(() => [...this.queryVector]);
  }

  override async embedPassages(texts: string[]): Promise<number[][]> {
    this.embeddedPassageTexts.push(texts);
    await this.embedGate?.();
    return texts.map(text => [...this.vectorForText(text)]);
  }
}

interface Fixture {
  baseDir: string;
  namespace: string;
  modelDir: string;
  model: FakeEmbeddingModel;
  subsystem: EmbeddingSubsystem;
}

async function makeFixture(namespace = 'tenant-1'): Promise<Fixture> {
  const baseDir = await mkdtemp(path.join(tmpdir(), 'embretr-'));
  const modelDir = path.join(baseDir, 'model');
  const model = new FakeEmbeddingModel();
  const subsystem = new EmbeddingSubsystem({ baseDir, namespace, modelDir, batchSize: 2, model });
  return { baseDir, namespace, modelDir, model, subsystem };
}

async function cleanup(fixture: Fixture): Promise<void> {
  await rm(fixture.baseDir, { recursive: true, force: true });
}

async function retainTexts(fixture: Fixture, texts: string[], day = '2026-09-19'): Promise<void> {
  const client = new MarkdownMemoryClient({ baseDir: fixture.baseDir, namespace: fixture.namespace });
  await client.retain({
    items: texts.map((content, i) => ({
      content,
      timestamp: `${day}T10:0${String(i)}:00.000Z`,
      document_id: `doc-${String(i)}`,
    })),
    operationId: `op-${day}-${String(texts.length)}`,
    timeoutMs: 5000,
  });
}

async function waitForState(
  subsystem: EmbeddingSubsystem,
  state: EmbeddingSubsystemState,
  timeoutMs = 15000,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (subsystem.getStatus().state === state) {
      return;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for ${state}; last: ${subsystem.getStatus().detail}`);
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

describe('warmEmbeddingsAtBoot', () => {
  it('kicks the background warm without waiting: the subsystem reaches ready on its own', async () => {
    const baseDir = await mkdtemp(path.join(tmpdir(), 'bootwarm-'));
    try {
      const modelDir = path.join(baseDir, 'model');
      const options = { baseDir, namespace: 'default', modelDir, batchSize: 2, model: new FakeEmbeddingModel() };
      // Returns immediately — startup never waits for the download/backfill.
      warmEmbeddingsAtBoot(options);
      await waitForState(getEmbeddingSubsystem(options), 'ready');
      expect(getEmbeddingSubsystem(options).getStatus().state).toBe('ready');
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });

  it('a failed boot warm degrades to keyword fallback, not a throw', async () => {
    const baseDir = await mkdtemp(path.join(tmpdir(), 'bootwarm-fail-'));
    try {
      const model = new FakeEmbeddingModel();
      model.ready = false;
      const modelDir = path.join(baseDir, 'model');
      const options = { baseDir, namespace: 'default', modelDir, batchSize: 2, model };
      expect(() => warmEmbeddingsAtBoot(options)).not.toThrow();
      await waitForState(getEmbeddingSubsystem(options), 'unavailable');
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });
});

describe('automatic warm retry', () => {
  /**
   * A failed warm must retry on its own after the cooldown — the UI tells the
   * user "trying again automatically", and that has to be true even when no
   * chat turn ever calls ensureWarmed again.
   */
  it('retries a failed warm after the cooldown without any chat turn', async () => {
    jest.useFakeTimers();
    const fixture = await makeFixture('retry-cooldown');
    try {
      fixture.model.ready = false;
      const ensureReadySpy = jest.spyOn(fixture.model, 'ensureReady');
      fixture.subsystem.ensureWarmed();
      await jest.advanceTimersByTimeAsync(0);
      expect(ensureReadySpy).toHaveBeenCalledTimes(1);

      // Before the cooldown elapses: no new attempt.
      await jest.advanceTimersByTimeAsync(WARM_RETRY_COOLDOWN_MS - 1000);
      expect(ensureReadySpy).toHaveBeenCalledTimes(1);

      // The cooldown elapses: the pending timer fires and retries — no turn involved.
      await jest.advanceTimersByTimeAsync(1000);
      expect(ensureReadySpy).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
      await cleanup(fixture);
    }
  });

  it('a persistent failure retries about once a minute, never hot-looping', async () => {
    jest.useFakeTimers();
    const fixture = await makeFixture('retry-hotloop');
    try {
      fixture.model.ready = false;
      const ensureReadySpy = jest.spyOn(fixture.model, 'ensureReady');
      fixture.subsystem.ensureWarmed();
      await jest.advanceTimersByTimeAsync(0);
      // Five minutes pass: one attempt per cooldown, not a burst.
      await jest.advanceTimersByTimeAsync(5 * WARM_RETRY_COOLDOWN_MS);
      expect(ensureReadySpy).toHaveBeenCalledTimes(6);
    } finally {
      jest.useRealTimers();
      await cleanup(fixture);
    }
  });

  it('a fresh manual warm supersedes the pending retry instead of breaking the chain', async () => {
    jest.useFakeTimers();
    const fixture = await makeFixture('retry-supersede');
    try {
      fixture.model.ready = false;
      const ensureReadySpy = jest.spyOn(fixture.model, 'ensureReady');
      fixture.subsystem.ensureWarmed();
      await jest.advanceTimersByTimeAsync(0);
      expect(ensureReadySpy).toHaveBeenCalledTimes(1);

      // A turn comes in just after the cooldown while the automatic retry is
      // still pending: the fresh attempt supersedes it. (setSystemTime moves
      // the clock without firing the pending timer, like a turn arriving at
      // 61s while the retry is still armed for 60s.)
      jest.setSystemTime(Date.now() + WARM_RETRY_COOLDOWN_MS + 1000);
      fixture.subsystem.ensureWarmed();
      await jest.advanceTimersByTimeAsync(0);
      expect(ensureReadySpy).toHaveBeenCalledTimes(2);

      // The superseded timer is gone, and the fresh attempt armed its own
      // retry: the next cooldown still brings exactly one more attempt. Without
      // the supersede-clear, the stale timer would fire inside the new
      // attempt's cooldown, get gated, and silently end the chain here.
      await jest.advanceTimersByTimeAsync(WARM_RETRY_COOLDOWN_MS);
      expect(ensureReadySpy).toHaveBeenCalledTimes(3);
    } finally {
      jest.useRealTimers();
      await cleanup(fixture);
    }
  });

  it('eventual recovery moves the status to ready', async () => {
    jest.useFakeTimers();
    const fixture = await makeFixture('retry-recover');
    try {
      fixture.model.ready = false;
      fixture.subsystem.ensureWarmed();
      await jest.advanceTimersByTimeAsync(0);
      expect(fixture.subsystem.getStatus().state).toBe('unavailable');

      // The model comes back; the next automatic retry warms successfully.
      fixture.model.ready = true;
      await jest.advanceTimersByTimeAsync(WARM_RETRY_COOLDOWN_MS);
      // The warm's store load + backfill use real fs I/O, which fake time cannot advance:
      // hand the clock back and wait on the real status instead of counting fake ticks.
      jest.useRealTimers();
      await waitForState(fixture.subsystem, 'ready');
      expect(fixture.subsystem.getStatus().state).toBe('ready');
    } finally {
      jest.useRealTimers();
      await cleanup(fixture);
    }
  });
});

describe('pure ranking helpers', () => {
  it('cosineSimilarity scores identical/orthogonal/zero vectors', () => {
    expect(cosineSimilarity({ a: oneHot(0), b: oneHot(0) })).toBeCloseTo(1);
    expect(cosineSimilarity({ a: oneHot(0), b: oneHot(1) })).toBeCloseTo(0);
    expect(cosineSimilarity({ a: oneHot(0), b: new Array(EMBEDDING_DIMENSIONS).fill(0) })).toBe(0);
  });

  it('passesPeakGate needs the top score to stand out', () => {
    expect(passesPeakGate([1, 0, 0])).toBe(true);
    expect(passesPeakGate([0.5, 0.5, 0.5])).toBe(false);
    expect(passesPeakGate([])).toBe(false);
  });

  it('passesPeakGate excludes the top hit from its own baseline', () => {
    // Real journey values (3-entry corpus): the EN paraphrase peaks at 0.0529
    // against the full mean but 0.0793 against the rest — the top hit must not
    // drag its own baseline up, or small corpora can never pass the gate.
    expect(passesPeakGate([0.8188, 0.7224, 0.7565])).toBe(true);
    // A query with no clear winner stays gated even when scores are high.
    expect(passesPeakGate([0.7952, 0.794, 0.7091])).toBe(false);
  });

  it('passesPeakGate accepts a high-confidence top hit even with a tiny peak', () => {
    // Small homogeneous corpora: every entry scores high, so the peak shrinks
    // below the threshold even for a correct top hit. A top score >= 0.8 is
    // confident on its own.
    expect(passesPeakGate([0.85, 0.83, 0.82])).toBe(true);
    // Below the confidence threshold, the peak gate still applies.
    expect(passesPeakGate([0.79, 0.78, 0.77])).toBe(false);
  });

  it('passesPeakGate applies the confidence bypass only to small corpora', () => {
    // At the boundary (10 entries) the bypass still rescues flat-but-strong hits.
    expect(passesPeakGate([0.85, ...Array.from({ length: 9 }, () => 0.84)])).toBe(true);
    // Above it the bypass must not fire: junk queries reach 0.8+ at scale, so
    // the peak gate governs. 11 entries, top 0.85, peak 0.01.
    expect(passesPeakGate([0.85, ...Array.from({ length: 10 }, () => 0.84)])).toBe(false);
    // Real junk probe shape (48 entries, top 0.816, peak 0.042): rejected.
    expect(passesPeakGate([0.816, ...Array.from({ length: 47 }, () => 0.774)])).toBe(false);
    // Real valid query shape (48 entries, top 0.85, peak 0.076): the peak gate
    // alone accepts it, so nothing is lost by gating the bypass.
    expect(passesPeakGate([0.85, ...Array.from({ length: 47 }, () => 0.774)])).toBe(true);
  });

  it('rankByCosine sorts best-first', () => {
    const ranked = rankByCosine(oneHot(0), [
      { id: 'b', vector: oneHot(1) },
      { id: 'a', vector: oneHot(0) },
    ]);
    expect(ranked.map(hit => hit.id)).toEqual(['a', 'b']);
  });

  it('orderVectorFirst leads with vector hits and appends missed keyword ids', () => {
    expect(orderVectorFirst({ vectorOrder: ['a', 'b'], keywordOrder: ['b', 'c'] })).toEqual(['a', 'b', 'c']);
    expect(orderVectorFirst({ vectorOrder: [], keywordOrder: ['b'] })).toEqual(['b']);
  });
});

describe('getSharedEmbeddingModel', () => {
  it('shares one model per modelDir', () => {
    const dir = path.join(tmpdir(), `shared-model-${String(Date.now())}`);
    expect(getSharedEmbeddingModel({ modelDir: dir })).toBe(getSharedEmbeddingModel({ modelDir: dir }));
    expect(getSharedEmbeddingModel({ modelDir: dir })).not.toBe(getSharedEmbeddingModel({ modelDir: `${dir}-other` }));
  });
});

describe('EmbeddingSubsystem', () => {
  it('reports unavailable when the model cannot load', async () => {
    const fixture = await makeFixture();
    try {
      fixture.model.ready = false;
      fixture.subsystem.ensureWarmed();
      const status = fixture.subsystem.getStatus();
      expect(status.state).toBe('unavailable');
      expect(status.detail).toContain("isn't available");
      expect(
        await fixture.subsystem.fusedRank({ query: 'q', keywordHits: [], entryTexts: new Map(), timeoutMs: 5000 }),
      ).toBeUndefined();
    } finally {
      await cleanup(fixture);
    }
  });

  it('marks the model unavailable (not stuck loading) when the offline canary fails', async () => {
    // Regression: a verified cache whose extractor fails the self-check must
    // leave the model in 'unavailable' with a useful reason, not 'loading'.
    const modelDir = await mkdtemp(path.join(tmpdir(), 'emb-canary-'));
    try {
      const revisionDir = path.join(
        modelDir,
        'Xenova',
        'multilingual-e5-small',
        '761b726dd34fb83930e26aab4e9ac3899aa1fa78',
      );
      const files: Record<string, string> = {
        'config.json': '{}',
        'tokenizer.json': '{}',
        'tokenizer_config.json': '{}',
        'onnx/model_quantized.onnx': 'fake',
      };
      const expectedFiles: Record<string, string> = {};
      for (const [name, content] of Object.entries(files)) {
        const fullPath = path.join(revisionDir, name);
        await mkdir(path.dirname(fullPath), { recursive: true });
        await writeFile(fullPath, content);
        expectedFiles[name] = createHash('sha256').update(content).digest('hex');
      }
      // Zero vector: norm 0 fails the canary's 0.99–1.01 check.
      const zeroVector = new Array(EMBEDDING_DIMENSIONS).fill(0);
      const failingPipeline: EmbeddingPipeline = () => Promise.resolve({ tolist: () => [zeroVector] });
      const model = new EmbeddingModel({
        modelDir,
        expectedFiles,
        createPipeline: () => Promise.resolve(failingPipeline),
      });
      expect(await model.ensureReady()).toBe(false);
      expect(model.currentPhase).toBe('unavailable');
      expect(model.failureReason).toContain('self-check');
    } finally {
      await rm(modelDir, { recursive: true, force: true });
    }
  });

  it('backfills every entry, persists, and reports ready', async () => {
    const fixture = await makeFixture();
    try {
      await retainTexts(fixture, ['Alex booked SFO→ORD→MAD for Sep 22', 'Lexie is a Bernese Mountain Dog']);
      fixture.subsystem.ensureWarmed();
      await waitForState(fixture.subsystem, 'ready');
      const status = fixture.subsystem.getStatus();
      expect(status.indexedEntries).toBe(2);
      expect(status.detail).toContain('Smart search is on');
      const embedded = fixture.model.embeddedPassageTexts.flat();
      expect(embedded).toHaveLength(2);
      expect(embedded.some(text => text.includes('Alex booked'))).toBe(true);
    } finally {
      await cleanup(fixture);
    }
  });

  it('resumes a partial backfill instead of starting over', async () => {
    const fixture = await makeFixture();
    try {
      await retainTexts(fixture, ['one', 'two', 'three', 'four']);
      // First pass embeds everything.
      fixture.subsystem.ensureWarmed();
      await waitForState(fixture.subsystem, 'ready');
      expect(fixture.model.embeddedPassageTexts.flat()).toHaveLength(4);

      // A fresh subsystem over the same store only embeds what is missing.
      const model2 = new FakeEmbeddingModel();
      const subsystem2 = new EmbeddingSubsystem({
        baseDir: fixture.baseDir,
        namespace: fixture.namespace,
        modelDir: fixture.modelDir,
        batchSize: 2,
        model: model2,
      });
      subsystem2.ensureWarmed();
      await waitForState(subsystem2, 'ready');
      expect(model2.embeddedPassageTexts.flat()).toHaveLength(0);
    } finally {
      await cleanup(fixture);
    }
  });

  it('drops vectors for deleted memories on the next warm', async () => {
    const fixture = await makeFixture();
    try {
      await retainTexts(fixture, ['keep me', 'delete me']);
      fixture.subsystem.ensureWarmed();
      await waitForState(fixture.subsystem, 'ready');
      expect(fixture.subsystem.getStatus().indexedEntries).toBe(2);

      // Rewrite the daily log with one entry; the other id no longer exists.
      const day = path.join(fixture.baseDir, fixture.namespace, 'memory', '2026-09-19.md');
      await writeFile(day, '## 2026-09-19T10:00:00.000Z\n\nkeep me\n', 'utf8');

      const model2 = new FakeEmbeddingModel();
      const subsystem2 = new EmbeddingSubsystem({
        baseDir: fixture.baseDir,
        namespace: fixture.namespace,
        modelDir: fixture.modelDir,
        batchSize: 2,
        model: model2,
      });
      subsystem2.ensureWarmed();
      await waitForState(subsystem2, 'ready');
      expect(subsystem2.getStatus().indexedEntries).toBe(1);
    } finally {
      await cleanup(fixture);
    }
  });

  it('fusedRank returns undefined until the backfill completes', async () => {
    const fixture = await makeFixture();
    try {
      await retainTexts(fixture, ['something']);
      // No warm: the store is not backfilled.
      expect(
        await fixture.subsystem.fusedRank({
          query: 'something',
          keywordHits: [],
          entryTexts: new Map(),
          timeoutMs: 5000,
        }),
      ).toBeUndefined();
      // The fusedRank above kicked a background warm; let it settle before cleanup.
      await waitForState(fixture.subsystem, 'ready');
    } finally {
      await cleanup(fixture);
    }
  });

  it('fusedRank never waits for a download: keyword fallback while the model loads', async () => {
    const fixture = await makeFixture();
    try {
      await retainTexts(fixture, ['alpha entry', 'beta entry']);
      // The model is mid-download: ensureReady never resolves. fusedRank must
      // not await it — recall falls back to keywords immediately.
      fixture.model.phaseOverride = 'downloading';
      fixture.model.blockEnsureReady = true;
      const outcome = await fixture.subsystem.fusedRank({
        query: 'alpha',
        keywordHits: [],
        entryTexts: new Map(),
        timeoutMs: 5000,
      });
      expect(outcome).toBeUndefined();
    } finally {
      fixture.model.blockEnsureReady = false;
      fixture.model.phaseOverride = undefined;
      await cleanup(fixture);
    }
  });

  it('fusedRank stays keyword-only with a single indexed entry', async () => {
    const fixture = await makeFixture();
    try {
      await retainTexts(fixture, ['lone entry about the hotel']);
      fixture.subsystem.ensureWarmed();
      await waitForState(fixture.subsystem, 'ready');
      // One entry: the peak gate has no distribution to measure against, and
      // measured junk queries overlap relevant ones absolutely, so the vector
      // leg stays off and keywords do the work.
      expect(
        await fixture.subsystem.fusedRank({ query: 'hotel', keywordHits: [], entryTexts: new Map(), timeoutMs: 5000 }),
      ).toBeUndefined();
    } finally {
      await cleanup(fixture);
    }
  });

  it('serializes a racing backfill and incremental index onto one store', async () => {
    const fixture = await makeFixture();
    try {
      await retainTexts(fixture, ['alpha entry', 'beta entry']);
      let releaseGate: (() => void) | undefined;
      const gate = new Promise<void>(resolve => {
        releaseGate = resolve;
      });
      fixture.model.embedGate = () => gate;
      fixture.subsystem.ensureWarmed();
      const start = Date.now();
      while (fixture.model.embeddedPassageTexts.length === 0) {
        if (Date.now() - start > 10000) {
          throw new Error('backfill did not start embedding');
        }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      // Incremental indexing races the in-flight backfill; the mutation queue
      // serializes them so both land in the same store file.
      fixture.subsystem.indexNewEntries([{ id: 'md:tenant-1:2026-09-19.md#99', text: 'gamma entry' }]);
      releaseGate?.();
      fixture.model.embedGate = undefined;
      await waitForState(fixture.subsystem, 'ready');
      expect(fixture.subsystem.getStatus().indexedEntries).toBe(3);
    } finally {
      await cleanup(fixture);
    }
  });

  it('a failed warm retries after the cooldown instead of counting as a fresh warm', async () => {
    // A warm that never backfilled must not set the success timestamp, or the
    // 10-minute stale window would suppress retries of a persistent failure.
    const realNow = Date.now.bind(Date);
    let nowOffsetMs = 0;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => realNow() + nowOffsetMs);
    const fixture = await makeFixture();
    try {
      fixture.model.ready = false;
      fixture.subsystem.ensureWarmed();
      for (let i = 0; i < 10; i++) {
        await new Promise(resolve => setImmediate(resolve));
      }
      expect(fixture.subsystem.getStatus().state).toBe('unavailable');

      // Past the 60s retry cooldown but well inside the 10-minute stale
      // window: the retry must run. Under the old "success on any warm end"
      // behavior this stayed stuck until the stale window elapsed.
      nowOffsetMs = 61_000;
      fixture.model.ready = true;
      fixture.subsystem.ensureWarmed();
      await waitForState(fixture.subsystem, 'ready');
      expect(fixture.subsystem.getStatus().indexedEntries).toBe(0);
    } finally {
      await cleanup(fixture);
      nowSpy.mockRestore();
    }
  });

  it('a stale re-warm reconciles out-of-band edits without re-embedding everything', async () => {
    const realNow = Date.now.bind(Date);
    let nowOffsetMs = 0;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => realNow() + nowOffsetMs);
    const fixture = await makeFixture();
    try {
      await retainTexts(fixture, ['alpha entry', 'beta entry']);
      fixture.subsystem.ensureWarmed();
      await waitForState(fixture.subsystem, 'ready');

      // A retain after the backfill indexes incrementally; the client passes
      // the subsystem through so this also exercises the retain-time warm kick.
      const client = new MarkdownMemoryClient({
        baseDir: fixture.baseDir,
        namespace: fixture.namespace,
        embeddings: () => fixture.subsystem,
      });
      await client.retain({
        items: [{ content: 'gamma entry', timestamp: '2026-09-19T12:00:00.000Z', document_id: 'doc-g' }],
        operationId: 'op-gamma',
        timeoutMs: 5000,
      });
      const start = realNow();
      while (fixture.subsystem.getStatus().indexedEntries < 3) {
        if (realNow() - start > 10000) {
          throw new Error('incremental indexing did not land');
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      expect(fixture.model.embeddedPassageTexts.flat()).toHaveLength(3);

      // Edit gamma's text out of band, then let the warm go stale. The re-warm
      // reloads the store on the same single writer: it must pick up the edit
      // (re-embedding only gamma) without losing or redoing the other entries.
      const day = path.join(fixture.baseDir, fixture.namespace, 'memory', '2026-09-19.md');
      const original = await readFile(day, 'utf8');
      await writeFile(day, original.replace('gamma entry', 'gamma entry EDITED'), 'utf8');
      nowOffsetMs = 11 * 60_000;
      fixture.subsystem.ensureWarmed();
      // The re-warm is done once the edited entry is embedded and the subsystem is back to
      // ready: the status stays "backfilling" until the backfill's trailing save completes.
      // (Filesystem mtimes are too coarse to order a save against a wall-clock stamp.)
      const rewarmStart = realNow();
      while (fixture.model.embeddedPassageTexts.flat().length < 4 || fixture.subsystem.getStatus().state !== 'ready') {
        if (realNow() - rewarmStart > 15000) {
          throw new Error('stale re-warm did not reconcile the edit');
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      expect(fixture.subsystem.getStatus().indexedEntries).toBe(3);
      expect(fixture.model.embeddedPassageTexts.flat()).toHaveLength(4);
    } finally {
      await cleanup(fixture);
      nowSpy.mockRestore();
    }
  });

  it('an edited memory is re-embedded on the next warm', async () => {
    const fixture = await makeFixture();
    try {
      await retainTexts(fixture, ['breakfast was oatmeal', 'lunch was salad']);
      fixture.subsystem.ensureWarmed();
      await waitForState(fixture.subsystem, 'ready');
      expect(fixture.subsystem.getStatus().indexedEntries).toBe(2);

      // Edit the first entry's text out of band; the id stays positional.
      const day = path.join(fixture.baseDir, fixture.namespace, 'memory', '2026-09-19.md');
      const original = await readFile(day, 'utf8');
      await writeFile(day, original.replace('oatmeal', 'pancakes'), 'utf8');

      const model2 = new FakeEmbeddingModel();
      const subsystem2 = new EmbeddingSubsystem({
        baseDir: fixture.baseDir,
        namespace: fixture.namespace,
        modelDir: fixture.modelDir,
        batchSize: 2,
        model: model2,
      });
      subsystem2.ensureWarmed();
      await waitForState(subsystem2, 'ready');
      expect(subsystem2.getStatus().indexedEntries).toBe(2);
      // Only the edited entry's hash changed, so only it is re-embedded.
      expect(model2.embeddedPassageTexts.flat()).toHaveLength(1);
      expect(model2.embeddedPassageTexts.flat()[0]).toContain('pancakes');
    } finally {
      await cleanup(fixture);
    }
  });

  it('fusedRank returns undefined when no score peaks above the corpus', async () => {
    const fixture = await makeFixture();
    try {
      await retainTexts(fixture, ['alpha entry', 'beta entry']);
      // Every entry scores identically at 0.7: flat distribution, no peak, and
      // below the 0.8 confidence bypass — the vector leg must stay gated.
      const flatVector = (): number[] => {
        const values = new Array(EMBEDDING_DIMENSIONS).fill(0);
        values[0] = 0.7;
        values[1] = Math.sqrt(1 - 0.49);
        return values;
      };
      fixture.model.vectorForText = flatVector;
      fixture.model.queryVector = oneHot(0);
      fixture.subsystem.ensureWarmed();
      await waitForState(fixture.subsystem, 'ready');
      expect(
        await fixture.subsystem.fusedRank({
          query: 'anything',
          keywordHits: [],
          entryTexts: new Map(),
          timeoutMs: 5000,
        }),
      ).toBeUndefined();
    } finally {
      await cleanup(fixture);
    }
  });

  it('fusedRank leads with the vector order and prefers fresh keyword text', async () => {
    const fixture = await makeFixture();
    try {
      await retainTexts(fixture, ['alpha entry', 'beta entry']);
      fixture.model.vectorForText = text => {
        if (text.includes('alpha')) {
          return oneHot(0);
        }
        const mixed = oneHot(1);
        mixed[0] = 0.1;
        return mixed;
      };
      fixture.model.queryVector = oneHot(0);
      fixture.subsystem.ensureWarmed();
      await waitForState(fixture.subsystem, 'ready');

      // Keywords rank beta first; vectors rank alpha first (similarity 1 vs ~0.1).
      // The vector leg leads; the keyword-only id appends after.
      const fused = await fixture.subsystem.fusedRank({
        query: 'alpha',
        keywordHits: [{ id: 'md:tenant-1:2026-09-19.md#1', text: 'FRESH beta text' }],
        entryTexts: new Map([
          ['md:tenant-1:2026-09-19.md#0', 'alpha entry'],
          ['md:tenant-1:2026-09-19.md#1', 'FRESH beta text'],
        ]),
        timeoutMs: 5000,
      });
      expect(fused).toBeDefined();
      expect(fused?.map(hit => hit.id)).toEqual(['md:tenant-1:2026-09-19.md#0', 'md:tenant-1:2026-09-19.md#1']);
      // The keyword hit carries its freshly scanned text, not the indexed copy.
      expect(fused?.[0]?.text).toContain('alpha entry');
      expect(fused?.[1]?.text).toBe('FRESH beta text');
    } finally {
      await cleanup(fixture);
    }
  });

  it('finds a memory by meaning when keywords do not match', async () => {
    const fixture = await makeFixture();
    try {
      await retainTexts(fixture, ['Alex hotel in Madrid is Petit Palace', 'Lexie is a Bernese Mountain Dog']);
      fixture.model.vectorForText = text => (text.includes('hotel') ? oneHot(0) : oneHot(1));
      fixture.model.queryVector = oneHot(0);
      fixture.subsystem.ensureWarmed();
      await waitForState(fixture.subsystem, 'ready');

      const client = new MarkdownMemoryClient({
        baseDir: fixture.baseDir,
        namespace: fixture.namespace,
        embeddings: () => fixture.subsystem,
      });
      const outcome = await client.recall({
        query: 'accommodation in Spain',
        maxTokens: 4000,
        queryTimestamp: '2026-09-20T10:00:00.000Z',
        entityTokens: 0,
        timeoutMs: 5000,
      });
      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        // No keyword overlap ("accommodation in Spain" vs the entries), so a
        // keyword-only recall would return nothing; the vector leg finds it.
        expect(outcome.results.map(item => item.text)).toContainEqual(expect.stringContaining('Petit Palace'));
      }
    } finally {
      await cleanup(fixture);
    }
  });

  it('indexNewEntries makes a fresh retain searchable without a new backfill', async () => {
    const fixture = await makeFixture();
    try {
      await retainTexts(fixture, ['first memory']);
      fixture.subsystem.ensureWarmed();
      await waitForState(fixture.subsystem, 'ready');
      expect(fixture.subsystem.getStatus().indexedEntries).toBe(1);

      const client = new MarkdownMemoryClient({
        baseDir: fixture.baseDir,
        namespace: fixture.namespace,
        embeddings: () => fixture.subsystem,
      });
      await client.retain({
        items: [{ content: 'second memory', timestamp: '2026-09-19T12:00:00.000Z', document_id: 'doc-9' }],
        operationId: 'op-second',
        timeoutMs: 5000,
      });
      const start = Date.now();
      while (fixture.subsystem.getStatus().indexedEntries < 2) {
        if (Date.now() - start > 10000) {
          throw new Error('indexNewEntries did not index the retained entry');
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      expect(fixture.subsystem.getStatus().indexedEntries).toBe(2);
    } finally {
      await cleanup(fixture);
    }
  });
});

describe('namespace isolation', () => {
  it('keeps vector caches per namespace', async () => {
    const fixture = await makeFixture('tenant-a');
    const modelB = new FakeEmbeddingModel();
    const fixtureB: Fixture = {
      baseDir: fixture.baseDir,
      namespace: 'tenant-b',
      modelDir: path.join(fixture.baseDir, 'model-b'),
      model: modelB,
      subsystem: new EmbeddingSubsystem({
        baseDir: fixture.baseDir,
        namespace: 'tenant-b',
        modelDir: path.join(fixture.baseDir, 'model-b'),
        batchSize: 2,
        model: modelB,
      }),
    };
    try {
      await retainTexts(fixture, ['tenant a secret']);
      fixture.subsystem.ensureWarmed();
      await waitForState(fixture.subsystem, 'ready');

      fixtureB.subsystem.ensureWarmed();
      await waitForState(fixtureB.subsystem, 'ready');
      // Tenant B indexed nothing of its own.
      expect(fixtureB.subsystem.getStatus().indexedEntries).toBe(0);
    } finally {
      await cleanup(fixture);
    }
  });
});

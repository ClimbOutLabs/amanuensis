import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL_ID,
  EMBEDDING_MODEL_REVISION,
  EMBEDDING_PASSAGE_PREFIX,
  EMBEDDING_QUERY_PREFIX,
  EmbeddingModel,
  toVectorMatrix,
  verifyModelFiles,
  type EmbeddingModelPhase,
  type EmbeddingPipeline,
} from '../../../../src/runtime/memory/embeddingModel';

const TINY_FILES: Record<string, string> = {
  'config.json': sha('tiny config'),
  'onnx/model.bin': sha('tiny weights'),
};

function sha(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 384-dim unit-norm vector: passes the canary. */
function goodVector(): number[] {
  const component = 1 / Math.sqrt(EMBEDDING_DIMENSIONS);
  return new Array(EMBEDDING_DIMENSIONS).fill(component);
}

function makePipeline(texts: string[], vector: number[] = goodVector()): { tolist: () => unknown } {
  void texts;
  return { tolist: () => [vector] };
}

interface FakeHarness {
  modelRefs: string[];
  seenTexts: string[][];
}

function newHarness(): FakeHarness {
  return { modelRefs: [], seenTexts: [] };
}

function fakeCreatePipeline(harness: FakeHarness) {
  return async (input: { modelRef: string }): Promise<EmbeddingPipeline> => {
    harness.modelRefs.push(input.modelRef);
    const pipeline: EmbeddingPipeline = async texts => {
      harness.seenTexts.push(texts);
      return makePipeline(texts);
    };
    return pipeline;
  };
}

async function writeTinyFiles(modelDir: string): Promise<void> {
  const snapshot = path.join(modelDir, EMBEDDING_MODEL_ID, EMBEDDING_MODEL_REVISION);
  for (const [relative, content] of Object.entries({
    'config.json': 'tiny config',
    'onnx/model.bin': 'tiny weights',
  })) {
    const full = path.join(snapshot, relative);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content, 'utf8');
  }
}

async function writePoisonedFiles(modelDir: string): Promise<void> {
  const snapshot = path.join(modelDir, EMBEDDING_MODEL_ID, EMBEDDING_MODEL_REVISION);
  await mkdir(path.join(snapshot, 'onnx'), { recursive: true });
  await writeFile(path.join(snapshot, 'config.json'), 'poisoned', 'utf8');
  await writeFile(path.join(snapshot, 'onnx', 'model.bin'), 'tiny weights', 'utf8');
}

async function makeModelDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'embmodel-'));
}

describe('toVectorMatrix', () => {
  it('rejects non-arrays, wrong dims, and non-finite components', () => {
    expect(() => toVectorMatrix('nope')).toThrow();
    expect(() => toVectorMatrix([[1, 2]])).toThrow();
    expect(() => toVectorMatrix([new Array(EMBEDDING_DIMENSIONS).fill(Number.NaN)])).toThrow();
    expect(toVectorMatrix([goodVector()])).toHaveLength(1);
  });
});

describe('verifyModelFiles', () => {
  it('accepts the exact expected set with matching hashes', async () => {
    const dir = await makeModelDir();
    try {
      await writeTinyFiles(dir);
      expect(await verifyModelFiles(dir, TINY_FILES)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects missing dir, tampered content, extra files, and missing files', async () => {
    const dir = await makeModelDir();
    try {
      expect(await verifyModelFiles(dir, TINY_FILES)).toBe(false);
      await writeTinyFiles(dir);
      const snapshot = path.join(dir, EMBEDDING_MODEL_ID, EMBEDDING_MODEL_REVISION);
      await writeFile(path.join(snapshot, 'config.json'), 'tampered', 'utf8');
      expect(await verifyModelFiles(dir, TINY_FILES)).toBe(false);
      await writeFile(path.join(snapshot, 'config.json'), 'tiny config', 'utf8');
      await writeFile(path.join(snapshot, 'evil.bin'), 'x', 'utf8');
      expect(await verifyModelFiles(dir, TINY_FILES)).toBe(false);
      await rm(path.join(snapshot, 'evil.bin'));
      await rm(path.join(snapshot, 'onnx', 'model.bin'));
      expect(await verifyModelFiles(dir, TINY_FILES)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects symlinks instead of following them', async () => {
    const dir = await makeModelDir();
    try {
      await writeTinyFiles(dir);
      const snapshot = path.join(dir, EMBEDDING_MODEL_ID, EMBEDDING_MODEL_REVISION);
      await rm(path.join(snapshot, 'config.json'));
      await symlink('/etc/hostname', path.join(snapshot, 'config.json'));
      expect(await verifyModelFiles(dir, TINY_FILES)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects unexpected files anywhere under the cache, including a stale redundant config', async () => {
    const dir = await makeModelDir();
    try {
      await writeTinyFiles(dir);
      // A stray file at the cache root fails the whole-cache check.
      await writeFile(path.join(dir, 'stray.txt'), 'x', 'utf8');
      expect(await verifyModelFiles(dir, TINY_FILES)).toBe(false);
      await rm(path.join(dir, 'stray.txt'));
      expect(await verifyModelFiles(dir, TINY_FILES)).toBe(true);

      // The redundant config.json one level up is only trusted with the pinned hash.
      const redundant = path.join(dir, EMBEDDING_MODEL_ID, 'config.json');
      await writeFile(redundant, 'stale copy', 'utf8');
      expect(await verifyModelFiles(dir, TINY_FILES)).toBe(false);
      await writeFile(redundant, 'tiny config', 'utf8');
      expect(await verifyModelFiles(dir, TINY_FILES)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('EmbeddingModel', () => {
  it('applies the E5 query:/passage: prefixes unconditionally', async () => {
    const dir = await makeModelDir();
    try {
      await writeTinyFiles(dir);
      const harness = newHarness();
      const model = new EmbeddingModel({
        modelDir: dir,
        expectedFiles: TINY_FILES,
        createPipeline: fakeCreatePipeline(harness),
      });
      expect(await model.ensureReady()).toBe(true);
      await model.embedQueries(['hello']);
      await model.embedPassages(['world']);
      expect(harness.seenTexts[1]).toEqual([`${EMBEDDING_QUERY_PREFIX}hello`]);
      expect(harness.seenTexts[2]).toEqual([`${EMBEDDING_PASSAGE_PREFIX}world`]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('loads a valid model folder from the verified revision directory', async () => {
    const dir = await makeModelDir();
    try {
      await writeTinyFiles(dir);
      const harness = newHarness();
      const model = new EmbeddingModel({
        modelDir: dir,
        expectedFiles: TINY_FILES,
        createPipeline: fakeCreatePipeline(harness),
      });
      expect(await model.ensureReady()).toBe(true);
      // Offline loads use the verified revision directory directly, not the
      // model ID: transformers.js with allowRemote=false resolves IDs via
      // env.localModelPath (no revision) and never finds the pinned files.
      expect(harness.modelRefs).toEqual([path.join(dir, EMBEDDING_MODEL_ID, EMBEDDING_MODEL_REVISION)]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('never downloads: a missing model stays keyword-only and says where the files go', async () => {
    const dir = await makeModelDir();
    const logs: string[] = [];
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    try {
      const harness = newHarness();
      const model = new EmbeddingModel({
        modelDir: dir,
        expectedFiles: TINY_FILES,
        log: message => logs.push(message),
        createPipeline: fakeCreatePipeline(harness),
      });
      expect(await model.ensureReady()).toBe(false);
      const phase: EmbeddingModelPhase = model.currentPhase;
      expect(phase).toBe('unavailable');
      expect(harness.modelRefs).toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(model.failureReason).toContain(dir);
      expect(model.failureReason).toContain('Copy the model files there');
      expect(logs.join('\n')).toContain("Smart search isn't available");
      // A second ensureReady does not check again within the cooldown.
      expect(await model.ensureReady()).toBe(false);
      expect(logs).toHaveLength(1);
    } finally {
      fetchSpy.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('never builds a pipeline from unverified bytes', async () => {
    // Tampered bytes must never reach the ONNX parser: the pipeline builder
    // does not run at all when verification fails.
    const dir = await makeModelDir();
    try {
      await writePoisonedFiles(dir);
      const harness = newHarness();
      const model = new EmbeddingModel({
        modelDir: dir,
        expectedFiles: TINY_FILES,
        createPipeline: fakeCreatePipeline(harness),
      });
      expect(await model.ensureReady()).toBe(false);
      expect(model.currentPhase).toBe('unavailable');
      expect(harness.modelRefs).toEqual([]);
      expect(model.failureReason).toContain('do not match the pinned ones');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('leaves a model folder with stray files in place and stays keyword-only', async () => {
    // The folder belongs to whoever filled it: nothing is wiped or rewritten.
    const dir = await makeModelDir();
    try {
      await writeTinyFiles(dir);
      const stray = path.join(dir, EMBEDDING_MODEL_ID, EMBEDDING_MODEL_REVISION, 'evil.bin');
      await writeFile(stray, 'x', 'utf8');
      const linkTarget = path.join(dir, EMBEDDING_MODEL_ID, EMBEDDING_MODEL_REVISION, 'config.json');
      await rm(linkTarget);
      await symlink('/etc/hostname', linkTarget);
      const harness = newHarness();
      const model = new EmbeddingModel({
        modelDir: dir,
        expectedFiles: TINY_FILES,
        createPipeline: fakeCreatePipeline(harness),
      });
      expect(await model.ensureReady()).toBe(false);
      expect(harness.modelRefs).toEqual([]);
      expect(await readFile(stray, 'utf8')).toBe('x');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fails closed when the canary is not unit-norm', async () => {
    const dir = await makeModelDir();
    try {
      await writeTinyFiles(dir);
      const harness = newHarness();
      const model = new EmbeddingModel({
        modelDir: dir,
        expectedFiles: TINY_FILES,
        createPipeline: async input => {
          harness.modelRefs.push(input.modelRef);
          const pipeline: EmbeddingPipeline = async texts =>
            makePipeline(texts, new Array(EMBEDDING_DIMENSIONS).fill(0.5));
          return pipeline;
        },
      });
      expect(await model.ensureReady()).toBe(false);
      expect(model.failureReason).toContain('self-check');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('retries the load after the unavailable cooldown instead of latching forever', async () => {
    // Regression: a transient load failure must not disable smart search for
    // the process. ensureReady retries once the cooldown elapses.
    const realNow = Date.now.bind(Date);
    let nowOffsetMs = 0;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => realNow() + nowOffsetMs);
    const dir = await makeModelDir();
    try {
      let calls = 0;
      let failCanary = true;
      await writeTinyFiles(dir);
      const harness = newHarness();
      const model = new EmbeddingModel({
        modelDir: dir,
        expectedFiles: TINY_FILES,
        createPipeline: async input => {
          calls += 1;
          harness.modelRefs.push(input.modelRef);
          const pipeline: EmbeddingPipeline = async texts =>
            makePipeline(texts, failCanary ? new Array(EMBEDDING_DIMENSIONS).fill(0) : goodVector());
          return pipeline;
        },
      });
      expect(await model.ensureReady()).toBe(false);
      expect(model.currentPhase).toBe('unavailable');
      // Still cooling down: no new load attempt.
      expect(await model.ensureReady()).toBe(false);
      expect(calls).toBe(1);
      // After the cooldown the load is retried; the transient failure is gone.
      nowOffsetMs = 61_000;
      failCanary = false;
      expect(await model.ensureReady()).toBe(true);
      expect(model.currentPhase).toBe('ready');
      expect(calls).toBe(2);
    } finally {
      nowSpy.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('shares one load across concurrent ensureReady callers', async () => {
    const dir = await makeModelDir();
    try {
      let calls = 0;
      await writeTinyFiles(dir);
      const harness = newHarness();
      const model = new EmbeddingModel({
        modelDir: dir,
        expectedFiles: TINY_FILES,
        createPipeline: async input => {
          calls += 1;
          harness.modelRefs.push(input.modelRef);
          await new Promise(resolve => setTimeout(resolve, 50));
          const pipeline: EmbeddingPipeline = async texts => makePipeline(texts);
          return pipeline;
        },
      });
      const [a, b] = await Promise.all([model.ensureReady(), model.ensureReady()]);
      expect(a).toBe(true);
      expect(b).toBe(true);
      expect(calls).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps serving embeds after one embed fails', async () => {
    const dir = await makeModelDir();
    try {
      let calls = 0;
      await writeTinyFiles(dir);
      const harness = newHarness();
      const model = new EmbeddingModel({
        modelDir: dir,
        expectedFiles: TINY_FILES,
        createPipeline: async input => {
          harness.modelRefs.push(input.modelRef);
          const pipeline: EmbeddingPipeline = async texts => {
            calls += 1;
            // Call 1 is the self-check canary; the first real embed (call 2)
            // throws, proving the model keeps serving afterwards.
            if (calls === 2) {
              throw new Error('transient onnx failure');
            }
            return makePipeline(texts);
          };
          return pipeline;
        },
      });
      expect(await model.ensureReady()).toBe(true);
      await expect(model.embedQueries(['a'])).rejects.toThrow('transient onnx failure');
      const vectors = await model.embedQueries(['b']);
      expect(vectors).toHaveLength(1);
      expect(vectors[0]).toHaveLength(EMBEDDING_DIMENSIONS);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

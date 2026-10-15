import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  downloadPinnedModelFiles,
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
  downloadCalls: number;
  /** Simulates the raw-bytes download step; may throw to simulate failure. */
  downloadImpl: (modelDir: string) => Promise<void>;
}

function newHarness(downloadImpl: (modelDir: string) => Promise<void>): FakeHarness {
  return { modelRefs: [], seenTexts: [], downloadCalls: 0, downloadImpl };
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

function fakeDownload(harness: FakeHarness, modelDir: string) {
  return async (): Promise<void> => {
    harness.downloadCalls += 1;
    await harness.downloadImpl(modelDir);
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

async function poisonedDownload(modelDir: string): Promise<void> {
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

describe('downloadPinnedModelFiles', () => {
  const bodies: Record<string, string> = {
    'config.json': 'tiny config',
    'onnx/model.bin': 'tiny weights',
  };

  function fakeFetch(): typeof fetch {
    return async input => {
      const url = String(input);
      const relative = url.split('/resolve/')[1]?.split('/').slice(1).join('/') ?? 'missing';
      return new Response(bodies[relative] ?? 'missing');
    };
  }

  it('fetches the pinned revision URLs and stages files atomically with locked-down modes', async () => {
    const dir = await makeModelDir();
    try {
      const seenUrls: string[] = [];
      const fetchImpl: typeof fetch = async input => {
        seenUrls.push(String(input));
        return fakeFetch()(input);
      };
      await downloadPinnedModelFiles({ modelDir: dir, expectedFiles: TINY_FILES, fetchImpl });
      // The exact pinned revision is in every URL: no unpinned bytes accepted.
      expect(seenUrls).toHaveLength(2);
      for (const url of seenUrls) {
        expect(url).toContain(`/resolve/${EMBEDDING_MODEL_REVISION}/`);
      }
      const snapshot = path.join(dir, EMBEDDING_MODEL_ID, EMBEDDING_MODEL_REVISION);
      for (const [relative, content] of Object.entries(bodies)) {
        const full = path.join(snapshot, relative);
        const fileStat = await stat(full);
        expect(fileStat.isFile()).toBe(true);
        // No group/other access on downloaded model bytes.
        expect(fileStat.mode & 0o077).toBe(0);
        expect(sha(await readFile(full, 'utf8'))).toBe(sha(content));
      }
      // No staging leftovers: a partial download never looks complete.
      const leftovers: string[] = [];
      async function walk(current: string): Promise<void> {
        for (const entry of await readdir(current, { withFileTypes: true })) {
          const full = path.join(current, entry.name);
          if (entry.name.endsWith('.part')) {
            leftovers.push(full);
          }
          if (entry.isDirectory()) {
            await walk(full);
          }
        }
      }
      await walk(dir);
      expect(leftovers).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects a lying content-length without reading the body', async () => {
    const dir = await makeModelDir();
    try {
      const fetchImpl: typeof fetch = async () =>
        new Response('tiny', { headers: { 'content-length': String(10 * 1024 * 1024 * 1024) } });
      await expect(downloadPinnedModelFiles({ modelDir: dir, expectedFiles: TINY_FILES, fetchImpl })).rejects.toThrow(
        'too large',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('overwrites pre-existing targets so a retry can repair a failed attempt', async () => {
    const dir = await makeModelDir();
    try {
      // Simulate a previous attempt's leftovers: stale bytes already at the
      // pinned targets. rename(2) cannot replace these on Windows (EPERM),
      // so the downloader must clear them before moving staged files in.
      const snapshot = path.join(dir, EMBEDDING_MODEL_ID, EMBEDDING_MODEL_REVISION);
      for (const relative of Object.keys(bodies)) {
        const full = path.join(snapshot, relative);
        await mkdir(path.dirname(full), { recursive: true });
        await writeFile(full, 'stale bytes from a failed attempt', 'utf8');
      }
      await downloadPinnedModelFiles({ modelDir: dir, expectedFiles: TINY_FILES, fetchImpl: fakeFetch() });
      for (const [relative, content] of Object.entries(bodies)) {
        expect(sha(await readFile(path.join(snapshot, relative), 'utf8'))).toBe(sha(content));
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects a streamed body that exceeds the byte cap', async () => {
    const dir = await makeModelDir();
    try {
      const fetchImpl: typeof fetch = async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('0123456789abcdef'));
              controller.close();
            },
          }),
        );
      await expect(
        downloadPinnedModelFiles({
          modelDir: dir,
          expectedFiles: TINY_FILES,
          fetchImpl,
          maxBytes: 10,
        }),
      ).rejects.toThrow('too large');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('throws on HTTP errors without writing files', async () => {
    const dir = await makeModelDir();
    try {
      const fetchImpl: typeof fetch = async () => new Response('nope', { status: 404 });
      await expect(downloadPinnedModelFiles({ modelDir: dir, expectedFiles: TINY_FILES, fetchImpl })).rejects.toThrow(
        'HTTP 404',
      );
      expect(await verifyModelFiles(dir, TINY_FILES)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('EmbeddingModel', () => {
  it('applies the E5 query:/passage: prefixes unconditionally', async () => {
    const dir = await makeModelDir();
    try {
      const harness = newHarness(writeTinyFiles);
      const model = new EmbeddingModel({
        modelDir: dir,
        expectedFiles: TINY_FILES,
        createPipeline: fakeCreatePipeline(harness),
        downloadModelFiles: fakeDownload(harness, dir),
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

  it('stays offline when the cache is pre-seeded and valid', async () => {
    const dir = await makeModelDir();
    try {
      await writeTinyFiles(dir);
      const harness = newHarness(async () => {
        throw new Error('download must not run for a valid cache');
      });
      const model = new EmbeddingModel({
        modelDir: dir,
        expectedFiles: TINY_FILES,
        createPipeline: fakeCreatePipeline(harness),
        downloadModelFiles: fakeDownload(harness, dir),
      });
      expect(await model.ensureReady()).toBe(true);
      expect(harness.downloadCalls).toBe(0);
      // Offline loads use the verified revision directory directly, not the
      // model ID: transformers.js with allowRemote=false resolves IDs via
      // env.localModelPath (no revision) and never finds the pinned cache.
      expect(harness.modelRefs).toEqual([path.join(dir, EMBEDDING_MODEL_ID, EMBEDDING_MODEL_REVISION)]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('downloads raw bytes, verifies, then builds the pipeline offline', async () => {
    const dir = await makeModelDir();
    try {
      const order: string[] = [];
      const harness = newHarness(async modelDir => {
        order.push('download');
        await writeTinyFiles(modelDir);
      });
      const model = new EmbeddingModel({
        modelDir: dir,
        expectedFiles: TINY_FILES,
        createPipeline: async input => {
          order.push('pipeline');
          return fakeCreatePipeline(harness)(input);
        },
        downloadModelFiles: fakeDownload(harness, dir),
      });
      expect(await model.ensureReady()).toBe(true);
      // The parser is only ever constructed after the bytes verify.
      expect(order).toEqual(['download', 'pipeline']);
      expect(harness.modelRefs).toEqual([path.join(dir, EMBEDDING_MODEL_ID, EMBEDDING_MODEL_REVISION)]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('never builds a pipeline from unverified bytes', async () => {
    // Regression for the instantiate-before-verify BLOCK: hostile download
    // bytes must never reach the ONNX parser. The pipeline builder must not
    // run at all when verification fails.
    const dir = await makeModelDir();
    try {
      const harness = newHarness(poisonedDownload);
      const model = new EmbeddingModel({
        modelDir: dir,
        expectedFiles: TINY_FILES,
        createPipeline: fakeCreatePipeline(harness),
        downloadModelFiles: fakeDownload(harness, dir),
      });
      expect(await model.ensureReady()).toBe(false);
      expect(model.currentPhase).toBe('unavailable');
      expect(harness.modelRefs).toEqual([]);
      expect(model.failureReason).toContain('integrity check');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('retries the download exactly once, then gives up for the run', async () => {
    const dir = await makeModelDir();
    const logs: string[] = [];
    try {
      const harness = newHarness(async () => {
        throw new Error('boom');
      });
      const model = new EmbeddingModel({
        modelDir: dir,
        expectedFiles: TINY_FILES,
        log: message => logs.push(message),
        createPipeline: fakeCreatePipeline(harness),
        downloadModelFiles: fakeDownload(harness, dir),
      });
      expect(await model.ensureReady()).toBe(false);
      expect(harness.downloadCalls).toBe(2);
      // No pipeline is ever built from a failed download.
      expect(harness.modelRefs).toEqual([]);
      const phase: EmbeddingModelPhase = model.currentPhase;
      expect(phase).toBe('unavailable');
      // A second ensureReady does not retry within the cooldown.
      expect(await model.ensureReady()).toBe(false);
      expect(harness.downloadCalls).toBe(2);
      expect(logs.join('\n')).toContain("Smart search isn't available");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('wipes a structurally corrupt cache before downloading', async () => {
    // A stray file can never be repaired by overwriting pinned paths: the
    // cache is wiped so the download starts clean. verifyModelFiles would
    // otherwise fail on the stray file forever.
    const dir = await makeModelDir();
    try {
      await writeTinyFiles(dir);
      const snapshot = path.join(dir, EMBEDDING_MODEL_ID, EMBEDDING_MODEL_REVISION);
      const stray = path.join(snapshot, 'evil.bin');
      await writeFile(stray, 'x', 'utf8');
      const linkTarget = path.join(snapshot, 'config.json');
      await rm(linkTarget);
      await symlink('/etc/hostname', linkTarget);
      const harness = newHarness(writeTinyFiles);
      const model = new EmbeddingModel({
        modelDir: dir,
        expectedFiles: TINY_FILES,
        createPipeline: fakeCreatePipeline(harness),
        downloadModelFiles: fakeDownload(harness, dir),
      });
      expect(await model.ensureReady()).toBe(true);
      expect(harness.downloadCalls).toBe(1);
      expect(await verifyModelFiles(dir, TINY_FILES)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fails closed when the canary is not unit-norm', async () => {
    const dir = await makeModelDir();
    try {
      const harness = newHarness(writeTinyFiles);
      const model = new EmbeddingModel({
        modelDir: dir,
        expectedFiles: TINY_FILES,
        createPipeline: async input => {
          harness.modelRefs.push(input.modelRef);
          const pipeline: EmbeddingPipeline = async texts =>
            makePipeline(texts, new Array(EMBEDDING_DIMENSIONS).fill(0.5));
          return pipeline;
        },
        downloadModelFiles: fakeDownload(harness, dir),
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
      const harness = newHarness(writeTinyFiles);
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
        downloadModelFiles: fakeDownload(harness, dir),
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
      const harness = newHarness(writeTinyFiles);
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
        downloadModelFiles: fakeDownload(harness, dir),
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
      const harness = newHarness(writeTinyFiles);
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
        downloadModelFiles: fakeDownload(harness, dir),
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

import { mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { EMBEDDING_DIMENSIONS } from '../../../../../src/runtime/memory/embeddingModel';
import {
  readRecordedVectors,
  RECORD_COMMAND,
  RecordedEmbeddingModel,
  recordedKey,
  recordVectors,
  writeRecordedVectors,
} from '../../../../fixtures/memory/recordedVectors';

const JSON_FILE = 'multilingual-e5-small.json';
const BIN_FILE = 'multilingual-e5-small.bin';

function vectorOf(seed: number): number[] {
  return Array.from({ length: EMBEDDING_DIMENSIONS }, (_, index) => Math.fround((seed + index) / 1000));
}

describe('recorded vectors', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'recorded-vectors-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function editInfo(change: Record<string, unknown>): Promise<void> {
    const file = path.join(dir, JSON_FILE);
    const info: unknown = JSON.parse(await readFile(file, 'utf8'));
    await writeFile(file, JSON.stringify({ ...(typeof info === 'object' ? info : {}), ...change }), 'utf8');
  }

  it('gives back what was written', async () => {
    const vectors = new Map([
      ['bbbb', vectorOf(2)],
      ['aaaa', vectorOf(1)],
    ]);
    await writeRecordedVectors({ dir, vectors });
    const read = await readRecordedVectors({ dir });
    expect([...read.keys()]).toEqual(['aaaa', 'bbbb']);
    expect(read.get('aaaa')).toEqual(vectorOf(1));
    expect(read.get('bbbb')).toEqual(vectorOf(2));
    expect(await readFile(path.join(dir, JSON_FILE), 'utf8')).toMatch(/\n$/);
  });

  it('keys a text by what the model receives, prefix included', () => {
    expect(recordedKey({ kind: 'query', text: 'tea' })).toMatch(/^[0-9a-f]{16}$/);
    expect(recordedKey({ kind: 'query', text: 'tea' })).not.toBe(recordedKey({ kind: 'passage', text: 'tea' }));
  });

  it('reports a text that was not recorded and still answers with a unit vector', async () => {
    const recorded = vectorOf(5);
    const model = new RecordedEmbeddingModel(new Map([[recordedKey({ kind: 'passage', text: 'known' }), recorded]]));
    const [known, unknown] = await model.embedPassages(['known', 'unknown']);
    const [question] = await model.embedQueries(['unknown']);
    expect(known).toEqual(recorded);
    expect(unknown?.reduce((sum, value) => sum + value * value, 0)).toBe(1);
    expect(question).toEqual(unknown);
    expect(model.requestedTexts).toEqual([
      { kind: 'passage', text: 'known' },
      { kind: 'passage', text: 'unknown' },
      { kind: 'query', text: 'unknown' },
    ]);
    expect(model.missingTexts).toEqual([
      { kind: 'passage', text: 'unknown' },
      { kind: 'query', text: 'unknown' },
    ]);
    expect(model.currentPhase).toBe('ready');
    await expect(model.ensureReady()).resolves.toBe(true);
  });

  it('names the command when the files are missing', async () => {
    await expect(readRecordedVectors({ dir })).rejects.toThrow(RECORD_COMMAND);
  });

  it('names the command when the two files disagree in size', async () => {
    await writeRecordedVectors({ dir, vectors: new Map([['aaaa', vectorOf(1)]]) });
    await truncate(path.join(dir, BIN_FILE), 8);
    await expect(readRecordedVectors({ dir })).rejects.toThrow(RECORD_COMMAND);
  });

  it.each([{ model: 'other/model' }, { revision: 'other' }, { dimensions: 3 }])(
    'names the command when the recording is for another model: %j',
    async change => {
      await writeRecordedVectors({ dir, vectors: new Map([['aaaa', vectorOf(1)]]) });
      await editInfo(change);
      await expect(readRecordedVectors({ dir })).rejects.toThrow(RECORD_COMMAND);
    },
  );

  it('records one text at a time and writes the keys in sorted order', async () => {
    const batches: string[][] = [];
    const model = {
      embedQueries: async (texts: string[]): Promise<number[][]> => {
        batches.push(texts);
        return texts.map((_, index) => vectorOf(index));
      },
      embedPassages: async (texts: string[]): Promise<number[][]> => {
        batches.push(texts);
        return texts.map(() => vectorOf(100));
      },
    };
    const texts = Array.from({ length: 20 }, (_, index) => ({
      kind: 'passage' as const,
      text: `text ${String(index)}`,
    }));
    await recordVectors({ texts: [...texts, { kind: 'query', text: 'text 0' }], model, dir });
    expect(batches.map(batch => batch.length)).toEqual(Array.from({ length: 21 }, () => 1));
    const read = await readRecordedVectors({ dir });
    const keys = [...read.keys()];
    expect(keys).toHaveLength(21);
    expect(keys).toEqual([...keys].sort());
    expect(read.get(recordedKey({ kind: 'query', text: 'text 0' }))).toEqual(vectorOf(0));
  });
});

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';

import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL_ID,
  EMBEDDING_MODEL_REVISION,
  EMBEDDING_PASSAGE_PREFIX,
  EMBEDDING_QUERY_PREFIX,
  EmbeddingModel,
  type EmbeddingModelPhase,
} from '../../../src/runtime/memory/embeddingModel';

/** The unit tests cannot run the real model, so they read vectors recorded from it. */
export const RECORD_COMMAND = 'pnpm --filter @truefoundry/trueforge memory:record-vectors --model-dir <folder>';
const RECORD_ADVICE = `Run \`${RECORD_COMMAND}\` with the folder that holds the downloaded search model, then commit the two files it writes.`;

const BYTES_PER_FLOAT = 4;

const RecordedVectorsInfoSchema = z.strictObject({
  model: z.string(),
  revision: z.string(),
  dimensions: z.number().int().positive(),
  /** Sorted ascending; the vectors in the `.bin` file follow this order. */
  keys: z.array(z.string()),
});
type RecordedVectorsInfo = z.infer<typeof RecordedVectorsInfoSchema>;

/** A text the model is asked to embed, and whether it is a question or a stored passage. */
const RecordedTextSchema = z.strictObject({ kind: z.enum(['query', 'passage']), text: z.string() });
export type RecordedText = z.infer<typeof RecordedTextSchema>;
export const RecordedTextsSchema = z.array(RecordedTextSchema);

export type VectorsByKey = ReadonlyMap<string, readonly number[]>;

/** The key of a text: the first 16 hex characters of the SHA-256 of what the model receives, prefix included. */
export function recordedKey({ kind, text }: RecordedText): string {
  const prefix = kind === 'query' ? EMBEDDING_QUERY_PREFIX : EMBEDDING_PASSAGE_PREFIX;
  return createHash('sha256').update(`${prefix}${text}`).digest('hex').slice(0, 16);
}

function fileNamesIn(dir: string): { json: string; bin: string } {
  const name = EMBEDDING_MODEL_ID.slice(EMBEDDING_MODEL_ID.lastIndexOf('/') + 1);
  return { json: path.join(dir, `${name}.json`), bin: path.join(dir, `${name}.bin`) };
}

export async function writeRecordedVectors({ dir, vectors }: { dir: string; vectors: VectorsByKey }): Promise<void> {
  const keys = [...vectors.keys()].sort((a, b) => (a < b ? -1 : 1));
  const bytes = Buffer.alloc(keys.length * EMBEDDING_DIMENSIONS * BYTES_PER_FLOAT);
  keys.forEach((key, row) => {
    const vector = vectors.get(key);
    if (vector?.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(`The vector for ${key} does not have ${String(EMBEDDING_DIMENSIONS)} numbers.`);
    }
    vector.forEach((value, column) => {
      bytes.writeFloatLE(value, (row * EMBEDDING_DIMENSIONS + column) * BYTES_PER_FLOAT);
    });
  });
  const info: RecordedVectorsInfo = {
    model: EMBEDDING_MODEL_ID,
    revision: EMBEDDING_MODEL_REVISION,
    dimensions: EMBEDDING_DIMENSIONS,
    keys,
  };
  const files = fileNamesIn(dir);
  await mkdir(dir, { recursive: true });
  await writeFile(files.json, `${JSON.stringify(info, null, 2)}\n`, 'utf8');
  await writeFile(files.bin, bytes);
}

async function readOrExplain(file: string): Promise<Buffer> {
  try {
    return await readFile(file);
  } catch (error) {
    throw new Error(`The recorded search vectors are missing: ${file} could not be read. ${RECORD_ADVICE}`, {
      cause: error,
    });
  }
}

/** The vectors recorded from the real model, by key. Throws, with what to do, when they are missing or from another model. */
export async function readRecordedVectors({ dir }: { dir: string }): Promise<Map<string, number[]>> {
  const files = fileNamesIn(dir);
  const info = RecordedVectorsInfoSchema.parse(JSON.parse((await readOrExplain(files.json)).toString('utf8')));
  const bytes = await readOrExplain(files.bin);
  if (info.model !== EMBEDDING_MODEL_ID || info.revision !== EMBEDDING_MODEL_REVISION) {
    throw new Error(
      `The recorded search vectors come from ${info.model} at ${info.revision}, but the product uses ${EMBEDDING_MODEL_ID} at ${EMBEDDING_MODEL_REVISION}. ${RECORD_ADVICE}`,
    );
  }
  if (info.dimensions !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `The recorded search vectors have ${String(info.dimensions)} numbers each, but the product uses ${String(EMBEDDING_DIMENSIONS)}. ${RECORD_ADVICE}`,
    );
  }
  const expectedBytes = info.keys.length * info.dimensions * BYTES_PER_FLOAT;
  if (bytes.length !== expectedBytes) {
    throw new Error(
      `The two recorded vector files do not match: the list names ${String(info.keys.length)} texts, which needs ${String(expectedBytes)} bytes, but the data file has ${String(bytes.length)}. ${RECORD_ADVICE}`,
    );
  }
  const vectors = new Map<string, number[]>();
  info.keys.forEach((key, row) => {
    const vector: number[] = [];
    for (let column = 0; column < info.dimensions; column += 1) {
      vector.push(bytes.readFloatLE((row * info.dimensions + column) * BYTES_PER_FLOAT));
    }
    vectors.set(key, vector);
  });
  return vectors;
}

function unitVector(): number[] {
  return Array.from({ length: EMBEDDING_DIMENSIONS }, (_, index) => (index === 0 ? 1 : 0));
}

/** Answers from recorded vectors and remembers every text it was asked for, so one run can name all that are missing. */
export class RecordedEmbeddingModel extends EmbeddingModel {
  private readonly asked = new Map<string, RecordedText>();
  private readonly unrecorded = new Set<string>();

  constructor(private readonly vectors: VectorsByKey) {
    super({ modelDir: path.join(tmpdir(), 'recorded-embedding-model') });
  }

  /** Every text asked for, in the order it was first asked. */
  get requestedTexts(): RecordedText[] {
    return [...this.asked.values()];
  }

  /** The asked texts that have no recorded vector. */
  get missingTexts(): RecordedText[] {
    return [...this.asked.entries()].filter(([key]) => this.unrecorded.has(key)).map(([, text]) => text);
  }

  override get currentPhase(): EmbeddingModelPhase {
    return 'ready';
  }

  override ensureReady(): Promise<boolean> {
    return Promise.resolve(true);
  }

  override embedQueries(texts: string[]): Promise<number[][]> {
    return Promise.resolve(this.lookUp({ kind: 'query', texts }));
  }

  override embedPassages(texts: string[]): Promise<number[][]> {
    return Promise.resolve(this.lookUp({ kind: 'passage', texts }));
  }

  private lookUp({ kind, texts }: { kind: RecordedText['kind']; texts: string[] }): number[][] {
    return texts.map(text => {
      const key = recordedKey({ kind, text });
      if (!this.asked.has(key)) {
        this.asked.set(key, { kind, text });
      }
      const vector = this.vectors.get(key);
      if (vector === undefined) {
        this.unrecorded.add(key);
        return unitVector();
      }
      return [...vector];
    });
  }
}

/** Embeds the texts with `model`, 16 at a time, and writes the two files into `dir`. */
export async function recordVectors({
  texts,
  model,
  dir,
}: {
  texts: readonly RecordedText[];
  model: Pick<EmbeddingModel, 'embedQueries' | 'embedPassages'>;
  dir: string;
}): Promise<number> {
  const vectors = new Map<string, readonly number[]>();
  for (const kind of ['query', 'passage'] as const) {
    const wanted = [...new Set(texts.filter(text => text.kind === kind).map(text => text.text))];
    // One text at a time: a text's vector shifts slightly with what shares its batch, and a recording must not depend on the other texts.
    for (const text of wanted) {
      const [vector] = kind === 'query' ? await model.embedQueries([text]) : await model.embedPassages([text]);
      if (vector === undefined) {
        throw new Error('The model returned no vector for a text it was given.');
      }
      vectors.set(recordedKey({ kind, text }), vector);
    }
  }
  await writeRecordedVectors({ dir, vectors });
  return vectors.size;
}

/**
 * Silero VAD (MIT) through onnxruntime, in this process. It is a 2 MB model that reads one 32 ms
 * window in well under a millisecond, so a separate container would only add a network hop to every
 * window. The file is pinned by size and SHA-256: it is fetched once, checked, and checked again
 * before it is loaded, so a changed file never reaches the model parser.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type * as Ort from 'onnxruntime-node';

import { INPUT_SAMPLE_RATE } from '../audio';
import { VAD_WINDOW_SAMPLES } from './utteranceDetector';

/** Silero VAD v5.1.2, `src/silero_vad/data/silero_vad.onnx`. Where it is fetched from lives with the setup scripts. */
export const SILERO_VAD_MODEL = {
  fileName: 'silero_vad.onnx',
  size: 2_327_524,
  sha256: '2623a2953f6ff3d2c1e61740c6cdb7168133479b267dfef114a4a3cc5bdd788f',
} as const;

/** Reads one window of speech and says how likely it is to be speech. */
export interface SpeechProbability {
  probability(window: Int16Array): Promise<number>;
  /** Forget the running state, at the start of a new call. */
  reset(): void;
  /** Gives back what the model holds once the call is over. */
  dispose?(): Promise<void>;
}

/** An image carries the file; a checkout fetches it, which `pnpm dev` does itself. */
const MISSING_MODEL_MESSAGE =
  'Voice mode is missing its listening model. In a source checkout, run `pnpm voice:model` once; otherwise update Aman to the latest version. Then try again.';

export class VadModelUnavailableError extends Error {}

export interface PinnedModel {
  fileName: string;
  size: number;
  sha256: string;
}

function sha256Of(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** True when the bytes are the pinned file: its size and SHA-256 both match. */
export function matchesPin({ bytes, pin }: { bytes: Uint8Array; pin: PinnedModel }): boolean {
  return bytes.length === pin.size && sha256Of(bytes) === pin.sha256;
}

/** The model's bytes once their size and hash match the pin; the server never fetches it. */
export async function verifiedVadModel({
  dir,
  pin = SILERO_VAD_MODEL,
}: {
  dir: string;
  pin?: PinnedModel;
}): Promise<Uint8Array> {
  const bytes = await readFile(path.join(dir, pin.fileName)).catch((cause: unknown) => {
    throw new VadModelUnavailableError(MISSING_MODEL_MESSAGE, { cause });
  });
  if (!matchesPin({ bytes, pin })) {
    throw new VadModelUnavailableError(MISSING_MODEL_MESSAGE);
  }
  return bytes;
}

type OrtModule = typeof Ort;

/** One caller's running model state; create one per voice session. */
export class SileroSpeechProbability implements SpeechProbability {
  readonly #ort: OrtModule;
  readonly #session: Ort.InferenceSession;
  #state: Ort.Tensor;
  /** The model reads the 64 samples before each window as well. */
  #context = new Float32Array(CONTEXT_SAMPLES);

  private constructor({ ort, session }: { ort: OrtModule; session: Ort.InferenceSession }) {
    this.#ort = ort;
    this.#session = session;
    this.#state = freshState(ort);
  }

  /** `model` is the pinned file's bytes, already checked, so the file is not read again after the check. */
  static async load({ model }: { model: Uint8Array }): Promise<SileroSpeechProbability> {
    const ort = await import('onnxruntime-node');
    const session = await ort.InferenceSession.create(model, {
      intraOpNumThreads: 1,
      interOpNumThreads: 1,
      executionProviders: ['cpu'],
    });
    return new SileroSpeechProbability({ ort, session });
  }

  async probability(window: Int16Array): Promise<number> {
    const input = new Float32Array(CONTEXT_SAMPLES + VAD_WINDOW_SAMPLES);
    input.set(this.#context);
    for (let i = 0; i < VAD_WINDOW_SAMPLES; i += 1) {
      input[CONTEXT_SAMPLES + i] = (window[i] ?? 0) / 32768;
    }
    this.#context = input.slice(VAD_WINDOW_SAMPLES);
    const result = await this.#session.run({
      input: new this.#ort.Tensor('float32', input, [1, input.length]),
      state: this.#state,
      sr: new this.#ort.Tensor('int64', BigInt64Array.from([BigInt(INPUT_SAMPLE_RATE)]), []),
    });
    const { output, stateN } = result;
    if (output === undefined || stateN === undefined) {
      throw new Error('The listening model returned no answer');
    }
    this.#state = stateN;
    const value = output.data[0];
    return typeof value === 'number' ? value : 0;
  }

  async dispose(): Promise<void> {
    await this.#session.release();
  }

  reset(): void {
    this.#state = freshState(this.#ort);
    this.#context = new Float32Array(CONTEXT_SAMPLES);
  }
}

const CONTEXT_SAMPLES = 64;

function freshState(ort: OrtModule): Ort.Tensor {
  return new ort.Tensor('float32', new Float32Array(2 * 128), [2, 1, 128]);
}

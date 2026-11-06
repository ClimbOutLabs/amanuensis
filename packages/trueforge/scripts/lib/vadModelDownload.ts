import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  matchesPin,
  SILERO_VAD_MODEL,
  VadModelUnavailableError,
  type PinnedModel,
} from '../../src/voice/vad/sileroVad';

/** Setup-time and build-time source of the pinned model; the server never downloads it. */
export const SILERO_VAD_URL =
  'https://raw.githubusercontent.com/snakers4/silero-vad/v5.1.2/src/silero_vad/data/silero_vad.onnx';

/** Fetches the pinned file into `dir` for host development and tests; images carry it from their build. */
export async function downloadVadModel({
  dir,
  pin = SILERO_VAD_MODEL,
  url = SILERO_VAD_URL,
  fetchFile = fetch,
}: {
  dir: string;
  pin?: PinnedModel;
  url?: string;
  fetchFile?: typeof fetch;
}): Promise<string> {
  const target = path.join(dir, pin.fileName);
  const existing = await readFile(target).catch(() => undefined);
  if (existing !== undefined && matchesPin({ bytes: existing, pin })) {
    return target;
  }
  let bytes: Uint8Array;
  try {
    const response = await fetchFile(url, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) {
      throw new Error(`the download answered ${String(response.status)}`);
    }
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch (cause) {
    throw new VadModelUnavailableError(
      'Voice mode needs a small listening model that could not be downloaded. Check the internet connection, then try again.',
      { cause },
    );
  }
  if (!matchesPin({ bytes, pin })) {
    throw new VadModelUnavailableError(
      'The listening model that was downloaded is not the one Aman expects, so it was not used. Try again in a few minutes.',
    );
  }
  await mkdir(dir, { recursive: true });
  const partial = `${target}.partial`;
  await writeFile(partial, bytes);
  await rename(partial, target).catch(async (cause: unknown) => {
    await rm(partial, { force: true });
    throw new VadModelUnavailableError(
      'The listening model could not be saved. Check that the data folder is writable.',
      { cause },
    );
  });
  return target;
}

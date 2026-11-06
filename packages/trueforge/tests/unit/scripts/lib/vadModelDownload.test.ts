import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { downloadVadModel } from '../../../../scripts/lib/vadModelDownload';
import { VadModelUnavailableError, type PinnedModel } from '../../../../src/voice/vad/sileroVad';

describe('downloadVadModel', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'vad-pin-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function pinFor(bytes: Uint8Array): PinnedModel {
    return {
      fileName: 'model.onnx',
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  }
  const answer =
    (bytes: Uint8Array): typeof fetch =>
    () =>
      Promise.resolve(new Response(bytes));

  it('saves the pinned file and reuses it without asking again', async () => {
    const bytes = new TextEncoder().encode('model bytes');
    const pin = pinFor(bytes);
    const target = await downloadVadModel({ dir, pin, fetchFile: answer(bytes) });
    expect(new Uint8Array(await readFile(target))).toEqual(bytes);
    const never: typeof fetch = () => Promise.reject(new Error('should not download again'));
    await expect(downloadVadModel({ dir, pin, fetchFile: never })).resolves.toBe(target);
  });

  it('refuses a download that is not the pinned file, and saves nothing', async () => {
    const pin = pinFor(new TextEncoder().encode('model bytes'));
    const other = new TextEncoder().encode('model bytez');
    await expect(downloadVadModel({ dir, pin, fetchFile: answer(other) })).rejects.toBeInstanceOf(
      VadModelUnavailableError,
    );
    await expect(readFile(path.join(dir, 'model.onnx'))).rejects.toThrow();
  });

  it('replaces a saved file that no longer matches the pin', async () => {
    const bytes = new TextEncoder().encode('model bytes');
    await writeFile(path.join(dir, 'model.onnx'), 'tampered');
    const target = await downloadVadModel({ dir, pin: pinFor(bytes), fetchFile: answer(bytes) });
    expect(new Uint8Array(await readFile(target))).toEqual(bytes);
  });

  it('says what to do when the download fails', async () => {
    const pin = pinFor(new TextEncoder().encode('x'));
    const down: typeof fetch = () => Promise.reject(new Error('offline'));
    await expect(downloadVadModel({ dir, pin, fetchFile: down })).rejects.toThrow(/internet connection/);
  });
});

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  HarvestedFile,
  RunCodeCallOptions,
  RunCodeErrorCode,
  RunCodeResult,
} from '@truefoundry/trueforge-core/core';

import { z } from 'zod';
import { CHAT_IMAGE_LOCAL_MAX_BYTES } from '../../../../src/runtime/chatImages/limits';
import { createImageReencoder, type ImageSandbox } from '../../../../src/runtime/chatImages/reencodeInSandbox';

import { hostHasPillow, JPEG_WITH_EXIF, PNG_HTML_POLYGLOT, pythonImage, SVG_IMAGE } from './pythonImages';

const describeWithPillow = hostHasPillow() ? describe : describe.skip;

function okResult(stdout: string): RunCodeResult {
  return {
    status: 'ok',
    exit_code: 0,
    stdout,
    stderr: '',
    stdout_truncated: false,
    stderr_truncated: false,
    files_out: [],
    harvest_warnings: [],
  };
}

function harvest(name: string, bytes: Buffer): HarvestedFile {
  return { name, bytes, size_bytes: bytes.byteLength, sha256: '' };
}

/** Stands in for the slot driver: stages attachments into a temp /ingress and runs the script on the host. */
function hostPythonSandbox(): ImageSandbox & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    driverKind: 'slots',
    calls,
    runCode(rawInput: unknown, options?: RunCodeCallOptions): Promise<RunCodeResult> {
      calls.push(rawInput);
      const root = mkdtempSync(join(tmpdir(), 'chat-image-sandbox-'));
      try {
        const ingress = join(root, 'ingress');
        const egress = join(root, 'egress');
        mkdirSync(ingress);
        mkdirSync(egress);
        for (const attachment of options?.attachments ?? []) {
          writeFileSync(join(ingress, attachment.name), attachment.bytes);
        }
        const input = z.object({ code: z.string(), files_in: z.array(z.unknown()) }).parse(rawInput);
        expect(input.files_in).toEqual([]);
        const code = input.code.replaceAll('/ingress', ingress).replaceAll('/egress', egress);
        const run = spawnSync('python3', ['-c', code], { encoding: 'utf8' });
        const files = readdirSync(egress).map(name => harvest(name, readFileSync(join(egress, name))));
        return (options?.onHarvestedFiles?.(files) ?? Promise.resolve()).then(() => okResult(run.stdout));
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  };
}

describeWithPillow('createImageReencoder with the sandbox script', () => {
  it('stages the image as an attachment and returns the re-encoded PNG', async () => {
    const sandbox = hostPythonSandbox();
    const reencode = createImageReencoder({ resolveSandbox: () => sandbox });
    const outcome = await reencode({ bytes: pythonImage(JPEG_WITH_EXIF) });
    expect(outcome).toMatchObject({ ok: true, image: { type: 'png', width: 48, height: 64 } });
    expect(sandbox.calls).toHaveLength(1);
    expect(sandbox.calls[0]).toMatchObject({ language: 'python', timeout_seconds: 20 });
  });

  it('strips a polyglot payload', async () => {
    const reencode = createImageReencoder({ resolveSandbox: () => hostPythonSandbox() });
    const outcome = await reencode({ bytes: pythonImage(PNG_HTML_POLYGLOT) });
    expect(outcome.ok && outcome.image.bytes.includes('<script')).toBe(false);
  });
});

describe('createImageReencoder refusals', () => {
  const neverSandbox: ImageSandbox = {
    driverKind: 'slots',
    runCode: () => Promise.reject(new Error('the sandbox must not run')),
  };

  it('refuses SVG and unknown types before the sandbox runs', async () => {
    const reencode = createImageReencoder({ resolveSandbox: () => neverSandbox });
    await expect(reencode({ bytes: SVG_IMAGE })).resolves.toEqual({ ok: false, reason: 'unsupported_type' });
    await expect(reencode({ bytes: Buffer.from('%PDF-1.7') })).resolves.toEqual({
      ok: false,
      reason: 'unsupported_type',
    });
  });

  it('refuses an oversized file before the sandbox runs', async () => {
    const reencode = createImageReencoder({ resolveSandbox: () => neverSandbox });
    const big = Buffer.alloc(CHAT_IMAGE_LOCAL_MAX_BYTES + 1);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(big);
    await expect(reencode({ bytes: big })).resolves.toEqual({ ok: false, reason: 'too_large' });
  });

  it('refuses to decode outside the gVisor slot driver', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
    const docker = createImageReencoder({ resolveSandbox: () => ({ ...neverSandbox, driverKind: 'docker' }) });
    await expect(docker({ bytes: png })).resolves.toEqual({ ok: false, reason: 'sandbox_unavailable' });
    const none = createImageReencoder({ resolveSandbox: () => null });
    await expect(none({ bytes: png })).resolves.toEqual({ ok: false, reason: 'sandbox_unavailable' });
  });

  it('does not trust the type the sandbox reports', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
    const lying: ImageSandbox = {
      driverKind: 'slots',
      runCode: (_input, options) =>
        (
          options?.onHarvestedFiles?.([harvest('image.png', Buffer.from([0xff, 0xd8, 0xff, 0xe0]))]) ??
          Promise.resolve()
        ).then(() =>
          okResult('{"ok": true, "name": "image.png", "format": "png", "width": 1, "height": 1, "frames": 1}'),
        ),
    };
    const reencode = createImageReencoder({ resolveSandbox: () => lying });
    await expect(reencode({ bytes: png })).resolves.toEqual({ ok: false, reason: 'undecodable' });
  });

  it('treats unreadable sandbox output as undecodable', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
    const noisy: ImageSandbox = { driverKind: 'slots', runCode: () => Promise.resolve(okResult('Traceback ...')) };
    const reencode = createImageReencoder({ resolveSandbox: () => noisy });
    await expect(reencode({ bytes: png })).resolves.toEqual({ ok: false, reason: 'undecodable' });
  });

  it('reads a failed run as a verdict only when it says something about the image', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
    const failing = (error_code: RunCodeErrorCode) =>
      createImageReencoder({
        resolveSandbox: () => ({
          driverKind: 'slots',
          runCode: () =>
            Promise.resolve({
              status: 'failed',
              error_code,
              error: 'invented failure',
              stdout: '',
              stderr: '',
              stdout_truncated: false,
              stderr_truncated: false,
              files_out: [],
              harvest_warnings: [],
            }),
        }),
      });
    await expect(failing('memory_exceeded')({ bytes: png })).resolves.toEqual({ ok: false, reason: 'too_large' });
    await expect(failing('timeout')({ bytes: png })).resolves.toEqual({ ok: false, reason: 'too_large' });
    await expect(failing('image_unavailable')({ bytes: png })).resolves.toEqual({
      ok: false,
      reason: 'sandbox_unavailable',
    });
    await expect(failing('concurrency_exceeded')({ bytes: png })).rejects.toThrow('concurrency_exceeded');
  });

  it('runs at most two re-encodes at once', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
    let running = 0;
    let peak = 0;
    const slow: ImageSandbox = {
      driverKind: 'slots',
      runCode: async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise(resolve => setTimeout(resolve, 10));
        running -= 1;
        return okResult('{"ok": false, "reason": "undecodable"}');
      },
    };
    const reencode = createImageReencoder({ resolveSandbox: () => slow });
    await Promise.all(Array.from({ length: 5 }, () => reencode({ bytes: png })));
    expect(peak).toBe(2);
  });
});

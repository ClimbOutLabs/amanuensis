import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { z } from 'zod';

import type { ChatImageInputType } from '@truefoundry/trueforge-core/core/chatImages';
import { sniffOutputType } from '../../../../src/runtime/chatImages/imageSniff';
import { buildReencodeScript, REENCODE_INPUT_NAME } from '../../../../src/runtime/chatImages/reencodeScript';
import {
  ANIMATED_GIF,
  GIF_101_FRAMES,
  hostHasPillow,
  JPEG_WITH_EXIF,
  PNG_HTML_POLYGLOT,
  PNG_HUGE_HEADER,
  PNG_WITH_TEXT,
  pythonImage,
  SVG_IMAGE,
} from './pythonImages';

// The same script runs in the gVisor guest, which ships the same Pillow pin; here it runs on the host.
const describeWithPillow = hostHasPillow() ? describe : describe.skip;

interface ScriptRun {
  verdict: Record<string, unknown>;
  output: Buffer | undefined;
}

function runScript(input: { bytes: Buffer; expectedType: ChatImageInputType }): ScriptRun {
  const root = mkdtempSync(join(tmpdir(), 'chat-image-'));
  try {
    const ingress = join(root, 'ingress');
    const egress = join(root, 'egress');
    mkdirSync(ingress);
    mkdirSync(egress);
    writeFileSync(join(ingress, REENCODE_INPUT_NAME), input.bytes);
    const code = buildReencodeScript({ expectedType: input.expectedType, ingressDir: ingress, egressDir: egress });
    const run = spawnSync('python3', ['-c', code], { encoding: 'utf8' });
    expect(run.status).toBe(0);
    const verdict = z.record(z.string(), z.unknown()).parse(JSON.parse(run.stdout.trim().split('\n').pop() ?? '{}'));
    const name = verdict['name'];
    return { verdict, output: typeof name === 'string' ? readFileSync(join(egress, name)) : undefined };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describeWithPillow('re-encode script', () => {
  it('rebuilds a PNG from pixels and drops its text chunks', () => {
    const { verdict, output } = runScript({ bytes: pythonImage(PNG_WITH_TEXT), expectedType: 'png' });
    expect(verdict).toMatchObject({ ok: true, format: 'png', width: 40, height: 30, frames: 1 });
    expect(output && sniffOutputType(output)).toBe('png');
    expect(output?.includes('invented-secret-comment')).toBe(false);
    expect(output?.includes('tEXt')).toBe(false);
  });

  it('turns a JPEG into a PNG without EXIF, honouring the orientation first', () => {
    const { verdict, output } = runScript({ bytes: pythonImage(JPEG_WITH_EXIF), expectedType: 'jpeg' });
    // Orientation 6 rotates 64 x 48 to 48 x 64.
    expect(verdict).toMatchObject({ ok: true, format: 'png', width: 48, height: 64 });
    expect(output?.includes('InventedCameraMaker')).toBe(false);
    expect(output?.includes('Exif')).toBe(false);
  });

  it('keeps an animation as WebP within the frame cap', () => {
    const { verdict, output } = runScript({ bytes: pythonImage(ANIMATED_GIF), expectedType: 'gif' });
    expect(verdict).toMatchObject({ ok: true, format: 'webp', frames: 3 });
    expect(output && sniffOutputType(output)).toBe('webp');
  });

  it('refuses more frames than the cap', () => {
    const { verdict } = runScript({ bytes: pythonImage(GIF_101_FRAMES), expectedType: 'gif' });
    expect(verdict).toEqual({ ok: false, reason: 'too_large' });
  });

  it('refuses a header that claims too many pixels before decoding it', () => {
    const { verdict } = runScript({ bytes: pythonImage(PNG_HUGE_HEADER), expectedType: 'png' });
    expect(verdict).toEqual({ ok: false, reason: 'too_large' });
  });

  it('drops a payload appended to a valid image', () => {
    const { verdict, output } = runScript({ bytes: pythonImage(PNG_HTML_POLYGLOT), expectedType: 'png' });
    expect(verdict).toMatchObject({ ok: true, format: 'png' });
    expect(output?.includes('<script')).toBe(false);
  });

  it('refuses SVG even when the host expected a raster type', () => {
    expect(runScript({ bytes: SVG_IMAGE, expectedType: 'png' }).verdict).toEqual({
      ok: false,
      reason: 'unsupported_type',
    });
  });

  it('refuses a file whose decoded type differs from the sniffed one', () => {
    const { verdict } = runScript({ bytes: pythonImage(JPEG_WITH_EXIF), expectedType: 'png' });
    expect(verdict).toEqual({ ok: false, reason: 'unsupported_type' });
  });

  it('refuses a truncated image', () => {
    const png = pythonImage(PNG_WITH_TEXT);
    const { verdict } = runScript({ bytes: png.subarray(0, 60), expectedType: 'png' });
    expect(verdict['ok']).toBe(false);
    expect(['undecodable', 'unsupported_type']).toContain(verdict['reason']);
  });
});

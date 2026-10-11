import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SPRITES = ['listening', 'remembering', 'found-memories', 'doing', 'writing', 'still-writing'] as const;

const MAX_BYTES = 15 * 1024;
const MAX_WIDTH = 128;
const PROVENANCE_MARKER = Buffer.from('trainedAlgorithmicMedia', 'utf8');

function spritePath(name: string): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'assets', 'turn-status', `${name}.webp`);
}

/** Reads the VP8X/VP8/VP8L-less WebP header enough to confirm format and width. */
function webpWidth(bytes: Buffer): number {
  // RIFF....WEBP then chunks; VP8X carries canvas size at offset 24 (24-bit LE minus 1).
  expect(bytes.subarray(0, 4).toString('ascii')).toBe('RIFF');
  expect(bytes.subarray(8, 12).toString('ascii')).toBe('WEBP');
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const tag = bytes.subarray(offset, offset + 4).toString('ascii');
    const size = bytes.readUInt32LE(offset + 4);
    if (tag === 'VP8X') {
      const widthMinusOne = bytes.readUIntLE(offset + 8 + 4, 3);
      return widthMinusOne + 1;
    }
    if (tag === 'VP8 ') {
      // Lossy bitstream: 14-bit width at frame header; parse minimally.
      const frame = offset + 8;
      const width = bytes.readUInt16LE(frame + 6) & 0x3fff;
      return width;
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error('no VP8X/VP8 chunk found');
}

describe('turn-status sprite assets', () => {
  it.each(SPRITES)('%s ships as a small WebP with its provenance tag', name => {
    const path = spritePath(name);
    const bytes = readFileSync(path);

    expect(statSync(path).size).toBeLessThanOrEqual(MAX_BYTES);
    expect(webpWidth(bytes)).toBeLessThanOrEqual(MAX_WIDTH);
    expect(bytes.includes(PROVENANCE_MARKER)).toBe(true);
  });
});

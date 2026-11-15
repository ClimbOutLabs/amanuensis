import { randomBytes } from 'node:crypto';

import { createMasterKey } from '../../../src/secrets/keyCheck';
import { SealedFileError, openSealedStream, readSealedHeader, sealStream } from '../../../src/secrets/sealedStream';
import { SecretKeyMismatchError } from '../../../src/secrets/secretCipher';

const CHUNK = 64 * 1024;

async function* pieces(data: Buffer, size: number): AsyncGenerator<Buffer> {
  for (let offset = 0; offset < data.length; offset += size) {
    yield data.subarray(offset, offset + size);
  }
}

async function collect(source: AsyncIterable<Buffer>): Promise<Buffer> {
  const out: Buffer[] = [];
  for await (const piece of source) {
    out.push(piece);
  }
  return Buffer.concat(out);
}

async function seal(data: Buffer, masterKey: Buffer): Promise<Buffer> {
  return collect(sealStream({ source: pieces(data, 10_000), masterKey, recoveryCopy: 'enc:v1:copy' }));
}

function open(sealed: Buffer, masterKey: Buffer, pieceSize = 7_777): Promise<Buffer> {
  return collect(openSealedStream({ source: pieces(sealed, pieceSize), resolveMasterKey: () => masterKey }));
}

/** Byte offsets of each chunk (length prefix included) in a sealed buffer. */
function chunkRanges(sealed: Buffer): { start: number; end: number }[] {
  const headerLength = sealed.readUInt32BE(9);
  const ranges: { start: number; end: number }[] = [];
  let offset = 9 + 4 + headerLength;
  while (offset < sealed.length) {
    const end = offset + 4 + sealed.readUInt32BE(offset);
    ranges.push({ start: offset, end });
    offset = end;
  }
  return ranges;
}

describe('sealed stream', () => {
  const key = createMasterKey();

  it.each([0, 1, CHUNK - 1, CHUNK, CHUNK + 1, 3 * CHUNK, 3 * CHUNK + 12_345])('round-trips %i bytes', async size => {
    const data = randomBytes(size);
    const sealed = await seal(data, key);
    expect((await open(sealed, key)).equals(data)).toBe(true);
    expect((await open(sealed, key, 1_000_000)).equals(data)).toBe(true);
  });

  it('holds none of the original bytes and carries the recovery copy in its header', async () => {
    const canary = Buffer.from('chat-canary-51c7a9e0b2 '.repeat(5000));
    const sealed = await seal(canary, key);
    expect(sealed.includes('chat-canary-51c7a9e0b2')).toBe(false);
    const header = await readSealedHeader(pieces(sealed, 100));
    expect(header.recovery_copy).toBe('enc:v1:copy');
  });

  it('refuses another key', async () => {
    const sealed = await seal(randomBytes(1000), key);
    await expect(open(sealed, createMasterKey())).rejects.toThrow(SecretKeyMismatchError);
  });

  it('refuses a changed byte anywhere: header, chunk length, data or check value', async () => {
    const sealed = await seal(randomBytes(2 * CHUNK + 500), key);
    const ranges = chunkRanges(sealed);
    const first = ranges[0]?.start ?? 0;
    for (const position of [20, first + 2, first + 100, sealed.length - 1]) {
      const changed = Buffer.from(sealed);
      changed[position] = (changed[position] ?? 0) ^ 0x01;
      await expect(open(changed, key)).rejects.toThrow();
    }
  });

  it('refuses a file cut short, at a chunk boundary or inside a chunk', async () => {
    const sealed = await seal(randomBytes(2 * CHUNK + 500), key);
    const ranges = chunkRanges(sealed);
    expect(ranges).toHaveLength(3);
    const boundary = ranges[1]?.end ?? 0;
    await expect(open(sealed.subarray(0, boundary), key)).rejects.toThrow(SealedFileError);
    await expect(open(sealed.subarray(0, boundary + 50), key)).rejects.toThrow(SealedFileError);
    await expect(open(sealed.subarray(0, 30), key)).rejects.toThrow(SealedFileError);
  });

  it('refuses chunks that were swapped, dropped, repeated or added after the end', async () => {
    const sealed = await seal(randomBytes(3 * CHUNK + 500), key);
    const ranges = chunkRanges(sealed);
    const head = sealed.subarray(0, ranges[0]?.start ?? 0);
    const chunk = (i: number): Buffer => sealed.subarray(ranges[i]?.start ?? 0, ranges[i]?.end ?? 0);
    const variants = [
      [chunk(1), chunk(0), chunk(2), chunk(3)],
      [chunk(0), chunk(2), chunk(3)],
      [chunk(0), chunk(0), chunk(1), chunk(2), chunk(3)],
      [chunk(0), chunk(1), chunk(2), chunk(3), chunk(3)],
    ];
    for (const variant of variants) {
      await expect(open(Buffer.concat([head, ...variant]), key)).rejects.toThrow(SealedFileError);
    }
  });

  it('refuses chunks taken from another file sealed with the same key', async () => {
    const one = await seal(randomBytes(CHUNK + 10), key);
    const two = await seal(randomBytes(CHUNK + 10), key);
    const mixed = Buffer.concat([
      one.subarray(0, chunkRanges(one)[0]?.start ?? 0),
      two.subarray(chunkRanges(two)[0]?.start ?? 0),
    ]);
    await expect(open(mixed, key)).rejects.toThrow(SealedFileError);
  });

  it('refuses data that is not a sealed file', async () => {
    await expect(open(Buffer.from('just some text, not sealed at all'), key)).rejects.toThrow(SealedFileError);
    await expect(open(Buffer.alloc(0), key)).rejects.toThrow(SealedFileError);
  });
});

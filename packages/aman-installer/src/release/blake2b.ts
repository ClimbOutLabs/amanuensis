// Blake2b with a 64 byte output and no key, the pre-hash the minisign
// format uses for its pre-hashed (ED) signatures. Node's crypto has no
// Blake2b, so it is written here from the public description (RFC 7693).

const IV: readonly bigint[] = [
  0x6a09e667f3bcc908n,
  0xbb67ae8584caa73bn,
  0x3c6ef372fe94f82bn,
  0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n,
  0x9b05688c2b3e6c1fn,
  0x1f83d9abfb41bd6bn,
  0x5be0cd19137e2179n,
];

const SIGMA: readonly (readonly number[])[] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
];

const MASK = 0xffffffffffffffffn;

function rotateRight(value: bigint, bits: bigint): bigint {
  return ((value >> bits) | (value << (64n - bits))) & MASK;
}

function wordAt(block: Uint8Array, index: number): bigint {
  let word = 0n;
  const start = index * 8;
  for (let i = 7; i >= 0; i -= 1) {
    const byte = block[start + i];
    if (byte === undefined) {
      throw new Error('blake2b block read out of range');
    }
    word = (word << 8n) | BigInt(byte);
  }
  return word;
}

export function blake2b512(data: Uint8Array): Uint8Array {
  const state: bigint[] = [...IV];
  const paramFirst = IV[0];
  if (paramFirst === undefined) {
    throw new Error('blake2b constants missing');
  }
  // Parameter block for a 64 byte output, no key, fanout and depth of 1.
  state[0] = paramFirst ^ 0x01010040n;

  const compress = (block: Uint8Array, count: bigint, isLast: boolean): void => {
    const words: bigint[] = [];
    for (let i = 0; i < 16; i += 1) {
      words.push(wordAt(block, i));
    }
    const v: bigint[] = [...state, ...IV];
    const t0 = v[12];
    const t1 = v[13];
    if (t0 === undefined || t1 === undefined) {
      throw new Error('blake2b state missing');
    }
    v[12] = t0 ^ (count & MASK);
    v[13] = t1 ^ (count >> 64n);
    if (isLast) {
      const f = v[14];
      if (f === undefined) {
        throw new Error('blake2b state missing');
      }
      v[14] = f ^ MASK;
    }
    const at = (index: number): bigint => {
      const word = v[index];
      if (word === undefined) {
        throw new Error('blake2b state missing');
      }
      return word;
    };
    const mix = (a: number, b: number, c: number, d: number, x: bigint, y: bigint): void => {
      v[a] = (at(a) + at(b) + x) & MASK;
      v[d] = rotateRight(at(d) ^ at(a), 32n);
      v[c] = (at(c) + at(d)) & MASK;
      v[b] = rotateRight(at(b) ^ at(c), 24n);
      v[a] = (at(a) + at(b) + y) & MASK;
      v[d] = rotateRight(at(d) ^ at(a), 16n);
      v[c] = (at(c) + at(d)) & MASK;
      v[b] = rotateRight(at(b) ^ at(c), 63n);
    };
    for (const row of SIGMA) {
      const msg = (index: number): bigint => {
        const word = words[row[index] ?? 0];
        if (word === undefined) {
          throw new Error('blake2b word missing');
        }
        return word;
      };
      mix(0, 4, 8, 12, msg(0), msg(1));
      mix(1, 5, 9, 13, msg(2), msg(3));
      mix(2, 6, 10, 14, msg(4), msg(5));
      mix(3, 7, 11, 15, msg(6), msg(7));
      mix(0, 5, 10, 15, msg(8), msg(9));
      mix(1, 6, 11, 12, msg(10), msg(11));
      mix(2, 7, 8, 13, msg(12), msg(13));
      mix(3, 4, 9, 14, msg(14), msg(15));
    }
    for (let i = 0; i < 8; i += 1) {
      const merged = (state[i] ?? 0n) ^ (v[i] ?? 0n) ^ (v[i + 8] ?? 0n);
      state[i] = merged;
    }
  };

  let offset = 0;
  while (data.length - offset > 128) {
    compress(data.subarray(offset, offset + 128), BigInt(offset + 128), false);
    offset += 128;
  }
  const lastBlock = new Uint8Array(128);
  lastBlock.set(data.subarray(offset));
  compress(lastBlock, BigInt(data.length), true);

  const out = new Uint8Array(64);
  for (let i = 0; i < 8; i += 1) {
    let word = state[i] ?? 0n;
    for (let j = 0; j < 8; j += 1) {
      out[i * 8 + j] = Number(word & 0xffn);
      word >>= 8n;
    }
  }
  return out;
}

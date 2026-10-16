// QR code for a short link: byte mode, error correction level M, versions 1 to 10 (up to 213 characters).
// Run as `node qr.mjs <text>`: prints the code as two rows of modules per line for a terminal.

const SIZE_LIMIT_VERSION = 10;
const ECC_PER_BLOCK = [10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const BLOCKS = [1, 1, 1, 2, 2, 4, 4, 4, 5, 5];

function rawModules(version) {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const aligns = Math.floor(version / 7) + 2;
    result -= (25 * aligns - 10) * aligns - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

function dataCodewords(version) {
  return Math.floor(rawModules(version) / 8) - ECC_PER_BLOCK[version - 1] * BLOCKS[version - 1];
}

function alignmentPositions(version) {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const size = version * 4 + 17;
  const step = Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const positions = [6];
  for (let pos = size - 7; positions.length < count; pos -= step) positions.splice(1, 0, pos);
  return positions;
}

const EXP = new Array(512);
const LOG = new Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
})();

function multiply(a, b) {
  return a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]];
}

function reedSolomon(data, degree) {
  let generator = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = new Array(generator.length + 1).fill(0);
    generator.forEach((coefficient, j) => {
      next[j] ^= coefficient;
      next[j + 1] ^= multiply(coefficient, EXP[i]);
    });
    generator = next;
  }
  const remainder = new Array(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ remainder.shift();
    remainder.push(0);
    for (let i = 0; i < degree; i += 1) remainder[i] ^= multiply(generator[i + 1], factor);
  }
  return remainder;
}

function dataBytes(bytes, version) {
  const bits = [];
  const push = (value, length) => {
    for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, version <= 9 ? 8 : 16);
  for (const byte of bytes) push(byte, 8);
  const capacity = dataCodewords(version) * 8;
  push(0, Math.min(4, capacity - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);
  const out = [];
  for (let i = 0; i < bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  for (let pad = 0xec; out.length < dataCodewords(version); pad ^= 0xec ^ 0x11) out.push(pad);
  return out;
}

function interleave(data, version) {
  const blocks = BLOCKS[version - 1];
  const eccLength = ECC_PER_BLOCK[version - 1];
  const raw = Math.floor(rawModules(version) / 8);
  const short = blocks - (raw % blocks);
  const shortLength = Math.floor(raw / blocks);
  const split = [];
  let offset = 0;
  for (let i = 0; i < blocks; i += 1) {
    const length = shortLength - eccLength + (i < short ? 0 : 1);
    const part = data.slice(offset, offset + length);
    offset += length;
    split.push({ part, ecc: reedSolomon(part, eccLength) });
  }
  const out = [];
  for (let i = 0; i < shortLength - eccLength + 1; i += 1) {
    split.forEach(({ part }, j) => {
      if (i !== shortLength - eccLength || j >= short) out.push(part[i]);
    });
  }
  for (let i = 0; i < eccLength; i += 1) split.forEach(({ ecc }) => out.push(ecc[i]));
  return out;
}

function makeGrid(size) {
  return {
    size,
    dark: Array.from({ length: size }, () => new Array(size).fill(false)),
    fixed: Array.from({ length: size }, () => new Array(size).fill(false)),
  };
}

function setFunction(grid, x, y, dark) {
  if (x < 0 || y < 0 || x >= grid.size || y >= grid.size) return;
  grid.dark[y][x] = dark;
  grid.fixed[y][x] = true;
}

function drawFormat(grid, mask) {
  const data = (0 << 3) | mask; // level M is 0
  let rem = data;
  for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const bit = i => ((bits >>> i) & 1) !== 0;
  const { size } = grid;
  for (let i = 0; i <= 5; i += 1) setFunction(grid, 8, i, bit(i));
  setFunction(grid, 8, 7, bit(6));
  setFunction(grid, 8, 8, bit(7));
  setFunction(grid, 7, 8, bit(8));
  for (let i = 9; i < 15; i += 1) setFunction(grid, 14 - i, 8, bit(i));
  for (let i = 0; i < 8; i += 1) setFunction(grid, size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i += 1) setFunction(grid, 8, size - 15 + i, bit(i));
  setFunction(grid, 8, size - 8, true);
}

function drawFunctionPatterns(grid, version) {
  const { size } = grid;
  for (let i = 0; i < size; i += 1) {
    setFunction(grid, 6, i, i % 2 === 0);
    setFunction(grid, i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [
    [3, 3],
    [size - 4, 3],
    [3, size - 4],
  ]) {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const distance = Math.max(Math.abs(dx), Math.abs(dy));
        setFunction(grid, cx + dx, cy + dy, distance !== 2 && distance !== 4);
      }
    }
  }
  const positions = alignmentPositions(version);
  positions.forEach((cx, i) => {
    positions.forEach((cy, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === positions.length - 1) || (i === positions.length - 1 && j === 0))
        return;
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1)
          setFunction(grid, cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    });
  });
  drawFormat(grid, 0);
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i += 1) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i += 1) {
      const dark = ((bits >>> i) & 1) !== 0;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFunction(grid, a, b, dark);
      setFunction(grid, b, a, dark);
    }
  }
}

function drawCodewords(grid, codewords) {
  const { size } = grid;
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vertical = 0; vertical < size; vertical += 1) {
      for (let j = 0; j < 2; j += 1) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vertical : vertical;
        if (!grid.fixed[y][x] && i < codewords.length * 8) {
          grid.dark[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0;
          i += 1;
        }
      }
    }
  }
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  x => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function applyMask(grid, mask) {
  for (let y = 0; y < grid.size; y += 1) {
    for (let x = 0; x < grid.size; x += 1) {
      if (!grid.fixed[y][x] && MASKS[mask](x, y)) grid.dark[y][x] = !grid.dark[y][x];
    }
  }
}

/** Runs of five or more, 2x2 blocks and an uneven balance of dark and light, as the standard asks for. */
function penalty(grid) {
  const { size, dark } = grid;
  let score = 0;
  for (let a = 0; a < size; a += 1) {
    for (const horizontal of [true, false]) {
      let run = 1;
      for (let b = 1; b < size; b += 1) {
        const same = horizontal ? dark[a][b] === dark[a][b - 1] : dark[b][a] === dark[b - 1][a];
        run = same ? run + 1 : 1;
        if (run === 5) score += 3;
        else if (run > 5) score += 1;
      }
    }
  }
  let darkCount = 0;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (dark[y][x]) darkCount += 1;
      if (
        x + 1 < size &&
        y + 1 < size &&
        dark[y][x] === dark[y][x + 1] &&
        dark[y][x] === dark[y + 1][x] &&
        dark[y][x] === dark[y + 1][x + 1]
      )
        score += 3;
    }
  }
  const total = size * size;
  score += Math.floor(Math.abs(darkCount * 20 - total * 10) / total) * 10;
  return score;
}

/** The modules of the code for the text, as rows of booleans (true is dark). */
export function encode(text) {
  const bytes = [...new TextEncoder().encode(text)];
  let version = 1;
  while (version <= SIZE_LIMIT_VERSION && (version <= 9 ? 12 : 20) + bytes.length * 8 > dataCodewords(version) * 8)
    version += 1;
  if (version > SIZE_LIMIT_VERSION) throw new Error('The text is too long for a QR code here');
  const codewords = interleave(dataBytes(bytes, version), version);
  const size = version * 4 + 17;
  let best;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask += 1) {
    const grid = makeGrid(size);
    drawFunctionPatterns(grid, version);
    drawCodewords(grid, codewords);
    applyMask(grid, mask);
    drawFormat(grid, mask);
    const score = penalty(grid);
    if (score < bestScore) {
      best = grid;
      bestScore = score;
    }
  }
  return best.dark;
}

/** Two rows of modules per line with half blocks, dark on a light margin, as black on white. */
export function render(text) {
  const modules = encode(text);
  const margin = 2;
  const size = modules.length + margin * 2;
  const at = (x, y) =>
    x >= margin && y >= margin && x < size - margin && y < size - margin ? modules[y - margin][x - margin] : false;
  const lines = [];
  for (let y = 0; y < size; y += 2) {
    let line = '\u001b[30;107m';
    for (let x = 0; x < size; x += 1) {
      const top = at(x, y);
      const bottom = at(x, y + 1);
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
    }
    lines.push(`${line}\u001b[0m`);
  }
  return lines.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}` && process.argv[2] !== undefined) {
  process.stdout.write(`${render(process.argv[2])}\n`);
}

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import { encode, render } from '../lib/qr.mjs';

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');
const LINK = 'http://192.168.1.20:8791/trust';

function finderAt(modules, x0, y0) {
  const expected = ['1111111', '1000001', '1011101', '1011101', '1011101', '1000001', '1111111'];
  return expected.every((row, y) => [...row].every((cell, x) => modules[y0 + y][x0 + x] === (cell === '1')));
}

describe('the QR code for a short link', () => {
  it('is a square of the right size with the three corner marks and the timing lines', () => {
    const modules = encode(LINK);
    assert.equal(modules.length, 29);
    assert.ok(modules.every(row => row.length === 29));
    assert.ok(finderAt(modules, 0, 0) && finderAt(modules, 22, 0) && finderAt(modules, 0, 22));
    for (let i = 8; i < 21; i += 1) {
      assert.equal(modules[6][i], i % 2 === 0);
      assert.equal(modules[i][6], i % 2 === 0);
    }
  });

  it('is always the same for the same link, and different for another', () => {
    const hash = text =>
      createHash('sha256')
        .update(JSON.stringify(encode(text)))
        .digest('hex');
    assert.equal(hash(LINK), hash(LINK));
    assert.notEqual(hash(LINK), hash('http://192.168.1.21:8791/trust'));
    // Decoded as the same link by an independent reader when this value was recorded.
    assert.equal(hash(LINK), '288f1a003d4a68a25e2601d1467d979b32ebbb81ab614066f37befd4d2d14440');
  });

  it('grows with the text and refuses what cannot fit', () => {
    assert.equal(encode('a').length, 21);
    assert.equal(encode('x'.repeat(190)).length, 57);
    assert.throws(() => encode('x'.repeat(400)), /too long/);
  });

  it('prints dark modules in black on white, two rows to a line, with a margin', () => {
    const lines = render(LINK).split('\n');
    assert.equal(lines.length, Math.ceil((29 + 4) / 2));
    for (const line of lines) {
      assert.ok(line.startsWith('\u001b[30;107m') && line.endsWith('\u001b[0m'));
      assert.equal([...line.replace(ANSI, '')].length, 33);
    }
  });
});

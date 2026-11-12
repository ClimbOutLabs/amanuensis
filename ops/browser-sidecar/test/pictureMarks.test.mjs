import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { test } from 'node:test';

import { decodePng, encodePng, markPicture, MASK_COLOR } from '../src/pictureMarks.mjs';

/** A plain picture of one colour, as a PNG. */
function plainPng({ width, height, color }) {
  const pixels = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    pixels.set([...color, 0xff], i * 4);
  }
  return encodePng({ width, height, pixels });
}

function pixelAt(picture, x, y) {
  const at = (y * picture.width + x) * 4;
  return [...picture.pixels.subarray(at, at + 3)];
}

test('a PNG reads back as the pixels it was written from', () => {
  const png = plainPng({ width: 7, height: 5, color: [10, 200, 30] });
  const picture = decodePng(png);
  assert.equal(picture.width, 7);
  assert.equal(picture.height, 5);
  assert.deepEqual(pixelAt(picture, 6, 4), [10, 200, 30]);
});

test('anything that is not a PNG it reads is refused, so no copy is made', () => {
  assert.throws(() => decodePng(Buffer.from('not a picture')));
});

test('covers a hidden field completely and boxes each control in red, scaled to the picture', () => {
  const png = plainPng({ width: 200, height: 100, color: [255, 255, 255] });
  const marked = decodePng(
    markPicture({
      png,
      scale: 2,
      controls: [{ ref: 'e12', box: { left: 10, top: 20, width: 30, height: 10 } }],
      masks: [{ left: 60, top: 10, width: 20, height: 10 }],
    }),
  );
  // The whole field, in picture pixels, is the mask colour.
  for (const [x, y] of [
    [120, 20],
    [159, 39],
    [140, 30],
  ]) {
    assert.deepEqual(pixelAt(marked, x, y), MASK_COLOR, `masked at ${String(x)},${String(y)}`);
  }
  // The control's outline is red; its inside is the page as it was.
  assert.deepEqual(pixelAt(marked, 21, 50), [0xe0, 0, 0]);
  assert.deepEqual(pixelAt(marked, 50, 50), [255, 255, 255]);
  // Outside every box nothing changed.
  assert.deepEqual(pixelAt(marked, 190, 90), [255, 255, 255]);
});

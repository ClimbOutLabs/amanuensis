import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

import { createLineInput } from '../src/lineInput.ts';

test('two answers piped at once are both read, one per question', async () => {
  const input = new PassThrough();
  input.end('1\nyes\n');
  const lines = createLineInput(input);
  assert.equal(await lines.next(), '1');
  assert.equal(await lines.next(), 'yes');
  assert.equal(await lines.next(), null);
});

test('an input that ends without an answer answers null instead of waiting', async () => {
  const input = new PassThrough();
  const lines = createLineInput(input);
  const answer = lines.next();
  input.end();
  assert.equal(await answer, null);
  assert.equal(await lines.next(), null);
});

test('a last line without a line break is still an answer, and Windows line ends are dropped', async () => {
  const input = new PassThrough();
  input.end('no\r\nyes');
  const lines = createLineInput(input);
  assert.equal(await lines.next(), 'no');
  assert.equal(await lines.next(), 'yes');
});

test('a question asked before the answer arrives gets it', async () => {
  const input = new PassThrough();
  const lines = createLineInput(input);
  const answer = lines.next();
  input.write('main\n');
  assert.equal(await answer, 'main');
  lines.close();
  assert.equal(await lines.next(), null);
});

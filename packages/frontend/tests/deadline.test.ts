import assert from 'node:assert/strict';
import { test } from 'node:test';

import { withinDeadline } from './support/deadline.ts';

test('a test that finishes in time returns its result', async () => {
  assert.equal(await withinDeadline({ ms: 1_000, where: () => 'the start', run: async () => 'done' }), 'done');
});

test('a test that stops moving fails, naming the step it stopped at', async () => {
  let at = 'the start';
  const stuck = withinDeadline({
    ms: 50,
    where: () => at,
    run: async () => {
      at = 'opening the menu';
      await new Promise(() => undefined);
    },
  });
  await assert.rejects(stuck, /did not finish within 0 seconds\. It stopped at: opening the menu\./);
});

test('a failure inside the test is passed on as it is', async () => {
  const failed = withinDeadline({
    ms: 1_000,
    where: () => 'the start',
    run: async () => {
      throw new Error('the card is missing');
    },
  });
  await assert.rejects(failed, /the card is missing/);
});

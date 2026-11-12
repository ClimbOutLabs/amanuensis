import assert from 'node:assert/strict';
import { test } from 'node:test';

import { gettingStartedPage } from '../src/gettingStarted.ts';

test('the page says what just happened and names the address', () => {
  const page = gettingStartedPage('https://localhost:8443');
  assert.ok(page.includes('Aman is installed on this computer.'));
  assert.ok(page.includes('https://localhost:8443'));
});

test('the page names both Settings paths and the brief and connectors pages', () => {
  const page = gettingStartedPage('https://localhost:8443');
  assert.ok(page.includes('Settings, then Personalization'));
  assert.ok(page.includes('Settings, then Models'));
  assert.ok(page.includes('Settings, then Schedules'));
  assert.ok(page.includes('Settings, then Connectors'));
});

test('the page closes with the change-any-time line', () => {
  const page = gettingStartedPage('https://localhost:8443');
  assert.ok(page.includes('You can change any of this any time in Settings.'));
});

test('the page holds no em dash and no other claim', () => {
  const page = gettingStartedPage('https://localhost:8443');
  assert.ok(!page.includes('\u2014'), page);
  const paragraphs = page.match(/<p>/g) ?? [];
  assert.equal(paragraphs.length, 6);
});

test('an address with page characters is written safely', () => {
  const page = gettingStartedPage('https://example.test/?a="b"');
  assert.ok(!page.includes('?a="b"'));
  assert.ok(page.includes('?a=&quot;b&quot;'));
});

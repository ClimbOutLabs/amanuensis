import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const guideDir = path.join(repoRoot, 'packages/trueforge/guide');

// Maps each label a page tells the person to click to the UI file that owns it. This is the one list.
async function readLabelOwners() {
  return JSON.parse(await readFile(path.join(guideDir, 'ui-labels.json'), 'utf8'));
}

/** In guide pages, bold text means a label on screen. */
function boldPhrases(text) {
  return [...text.matchAll(/\*\*([^*]+)\*\*/g)].map(match => match[1]);
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True when the label is a whole string literal or a whole line of JSX text in the source. */
function sourceShowsLabel({ source, label }) {
  const escaped = escapeRegExp(label);
  return new RegExp(`(['"\`])${escaped}\\1|^\\s*${escaped}\\s*$|>${escaped}<`, 'm').test(source);
}

test('every label a page tells the person to click is listed with its UI file', async () => {
  const owners = await readLabelOwners();
  const topicsDir = path.join(guideDir, 'topics');
  for (const name of (await readdir(topicsDir)).filter(item => item.endsWith('.md'))) {
    for (const label of boldPhrases(await readFile(path.join(topicsDir, name), 'utf8'))) {
      assert.ok(owners[label] !== undefined, `${name} names "${label}", which is not in guide/ui-labels.json`);
    }
  }
});

test('every listed label still exists in the UI source that owns it', async () => {
  const owners = await readLabelOwners();
  for (const [label, file] of Object.entries(owners)) {
    const source = await readFile(path.join(repoRoot, file), 'utf8');
    assert.ok(
      sourceShowsLabel({ source, label }),
      `"${label}" is no longer in ${file}. Update the guide page and ui-labels.json.`,
    );
  }
});

test('every listed label is used by at least one page', async () => {
  const owners = await readLabelOwners();
  const topicsDir = path.join(guideDir, 'topics');
  const used = new Set();
  for (const name of (await readdir(topicsDir)).filter(item => item.endsWith('.md'))) {
    for (const label of boldPhrases(await readFile(path.join(topicsDir, name), 'utf8'))) {
      used.add(label);
    }
  }
  assert.deepEqual(
    Object.keys(owners).filter(label => !used.has(label)),
    [],
    'ui-labels.json lists labels no page uses',
  );
});

test('the label check fails when a label is renamed', () => {
  const source = "<Button>{'Build Agent'}</Button>";
  assert.ok(sourceShowsLabel({ source, label: 'Build Agent' }));
  assert.ok(!sourceShowsLabel({ source: source.replace('Build Agent', 'Make Agent'), label: 'Build Agent' }));
});

// The image copies its own files one by one, so a module the entrypoint imports but the Dockerfile leaves out
// passes every test run from this folder and still stops the container at start. This reads the copy list and
// follows the local imports from the CMD's file, so a new module fails here first.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SIDECAR_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DOCKERFILE = readFileSync(join(SIDECAR_ROOT, 'Dockerfile'), 'utf8');

// Every file a plain `COPY a b ./` line puts in the work folder.
function copiedFiles() {
  const files = new Set();
  for (const line of DOCKERFILE.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts[0] !== 'COPY' || parts.some(part => part.startsWith('--'))) continue;
    for (const source of parts.slice(1, -1)) files.add(source);
  }
  return files;
}

function startFile() {
  const cmdLine = DOCKERFILE.split('\n').find(line => line.startsWith('CMD '));
  assert.ok(cmdLine, 'Dockerfile has no CMD line');
  const script = JSON.parse(cmdLine.slice('CMD '.length)).find(arg => arg.startsWith('/app/'));
  assert.ok(script, 'the CMD runs no file from /app');
  return script.slice('/app/'.length);
}

// The relative modules a file imports, statically or dynamically, and the ones those import.
function localImports(first) {
  const seen = new Set();
  const queue = [first];
  while (queue.length > 0) {
    const file = queue.shift();
    if (file === undefined || seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(join(SIDECAR_ROOT, file), 'utf8');
    for (const match of source.matchAll(/(?:from|import)\s*\(?\s*'(\.\/[^']+)'/g)) {
      const target = match[1];
      if (target !== undefined) queue.push(target.slice(2));
    }
  }
  return seen;
}

describe('the calendar image', () => {
  it('copies every file the start command loads', () => {
    const copied = copiedFiles();
    const needed = localImports(startFile());
    assert.ok(needed.size > 1, 'the start file imports no local module, so the import scan is broken');
    for (const file of needed) {
      assert.ok(existsSync(join(SIDECAR_ROOT, file)), `${file} is imported but does not exist`);
      assert.ok(copied.has(file), `${file} is loaded at start but the Dockerfile does not copy it`);
    }
  });
});

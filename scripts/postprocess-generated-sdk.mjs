/**
 * Restores TrueForge's stable public SDK barrel after Fern generation.
 *
 * Fern names both the namespace and client `TrueForge`. Its generated barrel
 * resolves that collision by exporting only the namespace, which removes the
 * client class and the hand-maintained deterministic event helpers from the
 * package root. Keep this exact, fail-closed transform beside the generator
 * instead of editing generated output by hand.
 */
import { readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const indexPath = resolve(repositoryRoot, 'packages/trueforge-sdk/src/index.ts');
const referencePath = resolve(repositoryRoot, 'packages/trueforge-sdk/reference.md');

const fernIndex = [
  'export * as TrueForge from "./api/index.js";',
  'export type { BaseClientOptions, BaseRequestOptions } from "./BaseClient.js";',
  'export { TrueForgeError, TrueForgeTimeoutError } from "./errors/index.js";',
  'export * from "./exports.js";',
  'export * as serialization from "./serialization/index.js";',
  '',
].join('\n');

const stableIndex = [
  'export * as TrueForgeApi from "./api/index.js";',
  'export type { BaseClientOptions, BaseRequestOptions } from "./BaseClient.js";',
  'export { TrueForge } from "./Client.js";',
  'export * from "./errors/index.js";',
  'export { isEventDelta, mergeEventDelta } from "./events.js";',
  'export * from "./exports.js";',
  'export * as serialization from "./serialization/index.js";',
  '',
].join('\n');

function normalizeNewlines(value) {
  return value.replaceAll('\r\n', '\n');
}

const current = normalizeNewlines(await readFile(indexPath, 'utf8'));
if (current === stableIndex) {
  console.log('Generated SDK public index already has the stable TrueForge exports.');
} else if (current === fernIndex) {
  await writeFile(indexPath, stableIndex, 'utf8');
  console.log('Restored stable TrueForge client, API namespace, and event-helper exports.');
} else {
  throw new Error(
    `Refusing to rewrite unexpected generated SDK index at ${indexPath}. ` +
      'Update this generator-owned compatibility step for the new Fern output first.',
  );
}

const reference = normalizeNewlines(await readFile(referencePath, 'utf8'));
const cleanReference = reference
  .split('\n')
  .map(line => line.trimEnd())
  .join('\n');
if (reference !== cleanReference) {
  await writeFile(referencePath, cleanReference, 'utf8');
  console.log('Removed generator-owned trailing whitespace from the SDK reference.');
}

// Fern emits a placeholder test (`expect(true).toBe(true)`) that asserts
// nothing. The SDK ships real generated tests; delete the stub so the suite
// contains no decorative tests. Fail closed: if Fern changes the stub,
// update this step instead of silently keeping a new placeholder.
const customTestPath = resolve(repositoryRoot, 'packages/trueforge-sdk/tests/custom.test.ts');
const fernStub = [
  '/**',
  ' * This is a custom test file, if you wish to add more tests',
  ' * to your SDK.',
  ' * Be sure to mark this file in `.fernignore`.',
  ' *',
  ' * If you include example requests/responses in your fern definition,',
  ' * you will have tests automatically generated for you.',
  ' */',
  'describe("test", () => {',
  '    it("default", () => {',
  '        expect(true).toBe(true);',
  '    });',
  '});',
  '',
].join('\n');

let customTest = null;
try {
  customTest = normalizeNewlines(await readFile(customTestPath, 'utf8'));
} catch {
  // Absent: nothing to remove.
}
if (customTest === null) {
  console.log('Fern placeholder test already absent.');
} else if (customTest === fernStub) {
  await rm(customTestPath);
  console.log('Removed Fern placeholder test (expect(true).toBe(true)).');
} else {
  throw new Error(
    `Refusing to remove unexpected custom test at ${customTestPath}. ` +
      'Update this generator-owned compatibility step for the new Fern output first.',
  );
}

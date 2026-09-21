/**
 * Restores TrueForge's stable public SDK barrel after Fern generation.
 *
 * Fern names both the namespace and client `TrueForge`. Its generated barrel
 * resolves that collision by exporting only the namespace, which removes the
 * client class and the hand-maintained deterministic event helpers from the
 * package root. Keep this exact, fail-closed transform beside the generator
 * instead of editing generated output by hand.
 */
import { readFile, writeFile } from 'node:fs/promises';
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

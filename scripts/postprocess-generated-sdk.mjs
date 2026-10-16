/**
 * Restores TrueForge's stable public SDK barrel after Fern generation.
 *
 * Fern names both the namespace and client `TrueForge`. Its generated barrel
 * resolves that collision by exporting only the namespace, which removes the
 * client class and the hand-maintained deterministic event helpers from the
 * package root. Keep this exact, fail-closed transform beside the generator
 * instead of editing generated output by hand.
 *
 * It also adds the `prepack` script that copies the root LICENSE into the
 * package, because Fern's package.json lists LICENSE in `files` but never ships one.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const indexPath = resolve(repositoryRoot, 'packages/trueforge-sdk/src/index.ts');
const referencePath = resolve(repositoryRoot, 'packages/trueforge-sdk/reference.md');
const packageJsonPath = resolve(repositoryRoot, 'packages/trueforge-sdk/package.json');
const prepackScript = 'node ../../scripts/copy-license-files.mjs';

// Fern's export order is not stable across releases, so match by line set.
const fernIndexLines = [
  'export * as TrueForge from "./api/index.js";',
  'export type { BaseClientOptions, BaseRequestOptions } from "./BaseClient.js";',
  'export { TrueForgeError, TrueForgeTimeoutError } from "./errors/index.js";',
  'export * from "./exports.js";',
  'export * as serialization from "./serialization/index.js";',
];

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

function isFernIndex(value) {
  const lines = value.split('\n').filter(line => line !== '');
  return lines.length === fernIndexLines.length && fernIndexLines.every(line => lines.includes(line));
}

const current = normalizeNewlines(await readFile(indexPath, 'utf8'));
if (current === stableIndex) {
  console.log('Generated SDK public index already has the stable TrueForge exports.');
} else if (isFernIndex(current)) {
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

const packageJsonSource = await readFile(packageJsonPath, 'utf8');
const packageJson = JSON.parse(packageJsonSource);
if (packageJson.scripts?.prepack !== prepackScript) {
  // Fern emits 4-space JSON; keep its indentation and trailing-newline convention.
  const trailingNewline = packageJsonSource.endsWith('\n') ? '\n' : '';
  const nextPackageJson = { ...packageJson, scripts: { ...packageJson.scripts, prepack: prepackScript } };
  await writeFile(packageJsonPath, `${JSON.stringify(nextPackageJson, null, 4)}${trailingNewline}`, 'utf8');
  console.log('Added the license-copying prepack script to the SDK package.json.');
}

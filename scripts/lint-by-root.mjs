#!/usr/bin/env node
// Runs the root ESLint config once per lint root, each in its own process.
//
// The config is type-aware (projectService), and a project service never closes
// a project once a file has opened it. A single `eslint .` therefore holds every
// package's TypeScript program at once, and because packages resolve each
// other's sources through the `trueforge-dev` condition, the shared sources are
// loaded again in each program. That outgrew the CI heap and crashed lint.
//
// One process per root keeps only that root's programs alive. The roots cover
// exactly what `eslint .` covers: every directory under packages/ and mcp/, then
// the rest of the tree. New packages are picked up without editing this file.
//
// Usage: node scripts/lint-by-root.mjs [extra eslint args, e.g. --fix]
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const groupDirs = ['packages', 'mcp'];
const extraArgs = process.argv.slice(2);

const roots = groupDirs.flatMap(group =>
  readdirSync(group, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => join(group, entry.name))
    .sort(),
);

const runs = [
  ...roots.map(root => ({ name: root, args: [root] })),
  {
    name: '(rest of the tree)',
    args: ['.', ...groupDirs.flatMap(group => ['--ignore-pattern', `${group}/**`])],
  },
];

const eslintBin = join('node_modules', 'eslint', 'bin', 'eslint.js');
const failed = [];
for (const run of runs) {
  const cacheName = run.name.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'root';
  console.log(`\n▶ eslint ${run.name}`);
  const result = spawnSync(
    process.execPath,
    [
      eslintBin,
      ...run.args,
      // A root whose files are all ignored (the generated SDK) is not an error.
      '--no-error-on-unmatched-pattern',
      '--cache',
      '--cache-location',
      join('node_modules', '.cache', 'eslint', cacheName),
      ...extraArgs,
    ],
    { stdio: 'inherit' },
  );
  if (result.status !== 0) {
    failed.push(`${run.name} (${result.signal ?? `exit ${String(result.status)}`})`);
  }
}

if (failed.length > 0) {
  console.error(`\nESLint failed in: ${failed.join(', ')}`);
  process.exit(1);
}

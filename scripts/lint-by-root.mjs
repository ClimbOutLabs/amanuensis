#!/usr/bin/env node
// Runs the root ESLint config once per TypeScript project, each in its own process.
//
// The config is type-aware (projectService), and a project service never closes
// a project once a file has opened it. A single `eslint .` therefore holds every
// project's TypeScript program at once, and because packages resolve each
// other's sources through the `trueforge-dev` condition, the shared sources are
// loaded again in each program. That outgrew the CI heap and crashed lint.
//
// A lint root is every tracked directory that holds a tsconfig*.json. Each root
// is linted on its own, minus the roots nested inside it, and a last run covers
// the rest of the tree. Together the runs cover exactly what `eslint .` covers,
// and a new package or test project becomes its own root without editing this file.
//
// Usage: node scripts/lint-by-root.mjs [extra eslint args, e.g. --fix]
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';

const extraArgs = process.argv.slice(2);

const roots = [
  ...new Set(
    execFileSync('git', ['ls-files', '--', '*tsconfig*.json'], { encoding: 'utf8' })
      .split('\n')
      .filter(path => path.length > 0)
      .map(path => dirname(path))
      .filter(dir => dir !== '.'),
  ),
].sort();

const nestedIn = dir => roots.filter(other => other !== dir && other.startsWith(`${dir}/`));
const ignoring = dirs => dirs.flatMap(dir => ['--ignore-pattern', `${dir}/**`]);

const runs = [
  ...roots.map(root => ({ name: root, args: [root, ...ignoring(nestedIn(root))] })),
  { name: '(rest of the tree)', args: ['.', ...ignoring(roots)] },
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
      // A root whose files are all ignored (the generated SDK, test-only projects) is not an error.
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

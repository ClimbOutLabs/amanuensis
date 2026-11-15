#!/usr/bin/env node
// Fails (exit 1) when a source file is longer than the line limit, so no new oversized file appears.
// Files that were already too long when the check arrived are listed in file-size-baseline.json with
// their length then. Each may only shrink: once one gets shorter, its number is lowered to match, and
// once it fits under the limit, it leaves the list. Tests, generated code and vendored code are not checked.
//
// Usage: node scripts/check-file-sizes.mjs [--update]
//   --update lowers baseline numbers to match files that shrank and drops files that now fit or are gone.
//            It never raises a number or adds a file.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const LINE_LIMIT = 1000;

const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|py)$/;

// Not ours to split (generated or vendored), or not product code (tests and their fixtures).
const SKIPPED = [
  /(?:^|\/)tests?\//,
  /(?:^|\/)__tests__\//,
  /\.(?:test|spec)\.[cm]?[jt]sx?$/,
  /(?:^|\/)fixtures\//,
  /\.generated\.[cm]?[jt]sx?$/,
  /\.d\.ts$/,
  /^packages\/trueforge-sdk\//,
  /^mcp\/gmail\//,
  /(?:^|\/)vendor\//,
];

/**
 * Whether the size limit applies to a tracked file.
 * @param {string} file
 */
export function isCheckedFile(file) {
  return SOURCE_FILE.test(file) && !SKIPPED.some(pattern => pattern.test(file));
}

/**
 * Lines in a file's text, counted the way an editor numbers them.
 * @param {string} text
 */
export function countLines(text) {
  if (text.length === 0) return 0;
  const lines = text.split('\n').length;
  return text.endsWith('\n') ? lines - 1 : lines;
}

/**
 * Every size problem, and the baseline the tree would have if each grandfathered file's number matched it.
 * @param {{ files: string[], countLinesOf: (file: string) => number, baseline: Record<string, number> }} input
 * @returns {{ problems: string[], updatedBaseline: Record<string, number> }}
 */
export function findFileSizeProblems({ files, countLinesOf, baseline }) {
  const problems = [];
  const updatedBaseline = {};
  const tracked = new Set(files);

  for (const file of files) {
    if (!isCheckedFile(file)) continue;
    const lines = countLinesOf(file);
    const allowed = baseline[file];
    if (allowed === undefined) {
      if (lines > LINE_LIMIT) {
        problems.push(
          `${file}: ${lines} lines, over the ${LINE_LIMIT}-line limit. Split it into smaller files by job.`,
        );
      }
      continue;
    }
    if (lines > allowed) {
      problems.push(
        `${file}: grew from ${allowed} to ${lines} lines. It is already over the ${LINE_LIMIT}-line limit, so it may only shrink. Move the new code into its own file.`,
      );
      updatedBaseline[file] = allowed;
    } else if (lines <= LINE_LIMIT) {
      problems.push(
        `${file}: now ${lines} lines, under the limit. Run pnpm check:file-sizes --update to take it off the list.`,
      );
    } else if (lines < allowed) {
      problems.push(
        `${file}: shrank from ${allowed} to ${lines} lines. Run pnpm check:file-sizes --update to lower its number.`,
      );
      updatedBaseline[file] = lines;
    } else {
      updatedBaseline[file] = allowed;
    }
  }

  for (const file of Object.keys(baseline)) {
    if (!tracked.has(file) || !isCheckedFile(file)) {
      problems.push(
        `${file}: listed in the baseline but no longer checked. Run pnpm check:file-sizes --update to remove it.`,
      );
    }
  }

  return { problems, updatedBaseline };
}

function main() {
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const baselinePath = path.join(rootDir, 'scripts', 'file-size-baseline.json');
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: rootDir, encoding: 'utf8' })
    .split('\0')
    .filter(file => file.length > 0);
  const { problems, updatedBaseline } = findFileSizeProblems({
    files,
    countLinesOf: file => countLines(readFileSync(path.join(rootDir, file), 'utf8')),
    baseline,
  });

  if (process.argv.includes('--update')) {
    const sorted = Object.fromEntries(Object.entries(updatedBaseline).sort(([a], [b]) => a.localeCompare(b)));
    writeFileSync(baselinePath, `${JSON.stringify(sorted, null, 2)}\n`);
    const remaining = problems.filter(problem => !problem.includes('--update'));
    if (remaining.length === 0) {
      console.log('Baseline updated. File sizes are within the limit.');
      return;
    }
    for (const problem of remaining) console.error(`- ${problem}`);
    process.exit(1);
  }

  if (problems.length === 0) {
    console.log(`File sizes are within the ${LINE_LIMIT}-line limit.`);
    return;
  }
  for (const problem of problems) console.error(`- ${problem}`);
  process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

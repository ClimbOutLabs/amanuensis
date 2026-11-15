#!/usr/bin/env node
// Fails (exit 1) when tracked files break a layout rule from AGENTS.md that a script can decide:
// - tests live under a package's top-level test or tests directory, never under src
// - every nested AGENTS.md has a sibling CLAUDE.md that holds only `@AGENTS.md`
// - pull requests do not add changeset files (maintainers handle release versioning)
//
// Usage: node scripts/check-repo-rules.mjs

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_FILE = /(?:\.(?:test|spec)\.[cm]?[jt]sx?$)|(?:\/__tests__\/)/;

/**
 * Every layout rule the tracked files break.
 * @param {{ files: string[], readText: (file: string) => string }} input
 * @returns {string[]}
 */
export function findRepoRuleProblems({ files, readText }) {
  const problems = [];
  const tracked = new Set(files);
  for (const file of files) {
    if (/^packages\/[^/]+\/src\//.test(file) && TEST_FILE.test(file)) {
      problems.push(`${file}: tests live under the package's test or tests directory, mirroring src. Move it there.`);
    }
    if (path.posix.basename(file) === 'AGENTS.md' && file !== 'AGENTS.md') {
      const sibling = path.posix.join(path.posix.dirname(file), 'CLAUDE.md');
      if (!tracked.has(sibling)) {
        problems.push(`${file}: add ${sibling} containing only @AGENTS.md.`);
      } else if (readText(sibling).trim() !== '@AGENTS.md') {
        problems.push(`${sibling}: it must contain only @AGENTS.md.`);
      }
    }
    if (file.startsWith('.changeset/')) {
      problems.push(`${file}: pull requests do not add changeset files. Remove it.`);
    }
  }
  return problems;
}

function main() {
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: rootDir, encoding: 'utf8' })
    .split('\0')
    .filter(file => file.length > 0);
  const problems = findRepoRuleProblems({
    files,
    readText: file => readFileSync(path.join(rootDir, file), 'utf8'),
  });
  if (problems.length === 0) {
    console.log('Repository layout rules hold.');
    return;
  }
  for (const problem of problems) {
    console.error(`- ${problem}`);
  }
  process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

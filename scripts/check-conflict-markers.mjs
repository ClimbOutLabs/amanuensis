#!/usr/bin/env node
// Fails (exit 1) when a file tracked by git still holds a Git conflict marker: a line that starts
// with seven `<`, `>` or `|`. A merge left unfinished can pass every other check, because the
// markers are valid text to a formatter and to the help pack builder.
//
// A line of seven `=` is not checked: it is also a heading underline in Markdown.
//
// Usage: pnpm run test:conflict-markers

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// A Markdown formatter may put a backslash in front of a marker it does not understand.
const MARKER = /^\\?(<{7}|>{7}|\|{7})(\s|$)/;

/** The conflict marker lines in one file's text, as `{ line, text }`, numbered from 1. */
export function conflictMarkerLines(text) {
  const found = [];
  const lines = text.split('\n');
  for (const [index, line] of lines.entries()) {
    if (MARKER.test(line)) {
      found.push({ line: index + 1, text: line.trimEnd() });
    }
  }
  return found;
}

/** Every conflict marker in the tracked text files under `rootDir`. */
export function scanConflictMarkers(rootDir) {
  // A Git hook exports its own repository's variables; without them Git finds the repository from `rootDir`.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: rootDir, encoding: 'utf8', env })
    .split('\0')
    .filter(file => file !== '');
  const problems = [];
  for (const file of files) {
    let content;
    try {
      content = readFileSync(path.join(rootDir, file));
    } catch (error) {
      // A tracked file deleted in the working tree, or a submodule folder, has nothing to read.
      if (error.code === 'ENOENT' || error.code === 'EISDIR') {
        continue;
      }
      throw error;
    }
    // A NUL byte marks a binary file; pictures and fonts are not merged by hand.
    if (content.includes(0)) {
      continue;
    }
    for (const marker of conflictMarkerLines(content.toString('utf8'))) {
      problems.push({ file, ...marker });
    }
  }
  return problems;
}

function main() {
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const problems = scanConflictMarkers(rootDir);
  if (problems.length === 0) {
    console.log('No conflict markers in tracked files.');
    return;
  }
  for (const problem of problems) {
    console.error(`${problem.file}:${String(problem.line)}: ${problem.text}`);
  }
  console.error(
    `\n${String(problems.length)} conflict marker line(s) found. A merge was left unfinished in these files. Open each one, keep the text that should stay, delete the marker lines, and commit.`,
  );
  process.exitCode = 1;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

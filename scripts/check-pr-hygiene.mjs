#!/usr/bin/env node
// Fails (exit 1) when a pull request carries text that must not reach this public repository:
// assistant attribution blocks, footers and trailers, links to private assistant workspaces,
// private project-folder paths, or a privacy/license checklist in the description.
//
// It reads the title (PR_TITLE), which a squash merge makes the commit's first line, the description
// (PR_BODY), the message of every commit in BASE..HEAD, and every line the pull request adds. Each pattern names the places it applies to,
// because a word that is wrong in a description can be fine in code.
//
// Usage: PR_TITLE="..." PR_BODY="..." node scripts/check-pr-hygiene.mjs --base <sha> --head <sha>

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// This file and its test spell the patterns out, so their added lines are not scanned.
const SELF_PATHS = new Set(['scripts/check-pr-hygiene.mjs', 'tests/pr-hygiene.test.mjs']);

export const RULES = [
  {
    name: 'attribution marker',
    pattern: /claude-projects-attribution/i,
    where: ['body', 'commit', 'added'],
    fix: 'Remove the attribution comment.',
  },
  {
    name: '"Requested by" attribution line',
    pattern: /^\s*_?Requested by \*\*/im,
    where: ['body', 'commit'],
    fix: 'Remove the "Requested by" line.',
  },
  {
    name: 'link to a private assistant workspace',
    pattern: /\bclaude\.ai\/(?:code|project|chat|artifact|share)\b/i,
    where: ['body', 'commit', 'added'],
    fix: 'Remove the link. Describe what a public reader needs instead.',
  },
  {
    name: 'assistant footer',
    pattern: /Generated (?:with|by) \[?Claude Code|\bclaude\.com\/claude-code\b/i,
    where: ['body', 'commit', 'added'],
    fix: 'Remove the footer.',
  },
  {
    name: 'assistant co-author trailer',
    pattern: /^\s*Co-Authored-By:.*(?:\bClaude\b|@anthropic\.com)/im,
    where: ['body', 'commit'],
    fix: 'Remove the Co-Authored-By trailer and amend the commit.',
  },
  {
    name: 'assistant session trailer',
    pattern: /^\s*Claude-Session:/im,
    where: ['body', 'commit', 'added'],
    fix: 'Remove the Claude-Session trailer and amend the commit.',
  },
  {
    name: 'assistant session id',
    pattern: /\bsession_01[0-9A-Za-z]{20,}\b/,
    where: ['body', 'commit', 'added'],
    fix: 'Remove the session id.',
  },
  {
    name: 'private project-folder path',
    pattern: /\/mnt\/project-files\b/i,
    where: ['body', 'commit', 'added'],
    fix: 'Remove the path. Nothing in the project folder is public.',
  },
  {
    name: 'privacy or license checklist',
    // The checklist items, not the words: a Docs line may list docs/privacy.md, and a Testing line may name a license test.
    pattern:
      /^\s*[-*]\s+\[[ xX]\]\s+.*\b(?:no (?:private|personal) (?:info|information|data)|private data scan|licen[cs]e (?:ok|checked)|licensed under|copyleft|agpl)\b/im,
    where: ['body'],
    fix: 'Remove the checklist. CI checks dependency licenses, and the description does not carry one.',
  },
];

/**
 * Every rule broken by the title, the description, a commit message or an added line.
 * @param {{ title?: string, body: string, commits: { sha: string, message: string }[], addedLines: { file: string, line: number, text: string }[] }} input
 * @returns {string[]}
 */
export function findHygieneProblems({ title = '', body, commits, addedLines }) {
  const problems = [];
  for (const rule of RULES) {
    // A squash merge turns the title into the commit's first line, so it is read like a commit message.
    if (rule.where.includes('commit') && rule.pattern.test(title)) {
      problems.push(`PR title: ${rule.name}. ${rule.fix}`);
    }
    if (rule.where.includes('body') && rule.pattern.test(body)) {
      problems.push(`PR description: ${rule.name}. ${rule.fix}`);
    }
    if (rule.where.includes('commit')) {
      for (const commit of commits) {
        if (rule.pattern.test(commit.message)) {
          problems.push(`Commit ${commit.sha.slice(0, 12)} message: ${rule.name}. ${rule.fix}`);
        }
      }
    }
    if (rule.where.includes('added')) {
      for (const added of addedLines) {
        if (!SELF_PATHS.has(added.file) && rule.pattern.test(added.text)) {
          problems.push(`${added.file}:${added.line}: ${rule.name}. ${rule.fix}`);
        }
      }
    }
  }
  return problems;
}

/**
 * The lines a unified diff with zero context adds, with the file and the line number each lands on.
 * @param {string} diff
 * @returns {{ file: string, line: number, text: string }[]}
 */
export function parseAddedLines(diff) {
  const added = [];
  let file = '';
  let line = 0;
  // Lines still owed to the current hunk, from its header. Inside a hunk an added line may itself start
  // with "++ " or "@@", so headers are only read once the hunk's counts run out.
  let oldLeft = 0;
  let newLeft = 0;
  for (const raw of diff.split('\n')) {
    if (oldLeft > 0 || newLeft > 0) {
      if (raw.startsWith('+')) {
        if (file) {
          added.push({ file, line, text: raw.slice(1) });
        }
        line += 1;
        newLeft -= 1;
      } else if (raw.startsWith('-')) {
        oldLeft -= 1;
      } else if (raw.startsWith(' ')) {
        line += 1;
        oldLeft -= 1;
        newLeft -= 1;
      }
      continue;
    }
    if (raw.startsWith('+++ ')) {
      file = raw === '+++ /dev/null' ? '' : raw.replace(/^\+\+\+ b\//, '');
      continue;
    }
    const hunk = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw);
    if (hunk) {
      oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
      line = Number(hunk[2]);
      newLeft = hunk[3] === undefined ? 1 : Number(hunk[3]);
    }
  }
  return added;
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

function readCommits({ base, head }) {
  // NUL-separated so a message can hold any text.
  return git(['log', '-z', '--format=%H%n%B', `${base}..${head}`])
    .split('\0')
    .filter(entry => entry.trim().length > 0)
    .map(entry => {
      const newline = entry.indexOf('\n');
      return { sha: entry.slice(0, newline), message: entry.slice(newline + 1) };
    });
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function main() {
  const base = argValue('--base');
  const head = argValue('--head');
  if (!base || !head) {
    console.error('Usage: PR_TITLE="..." PR_BODY="..." node scripts/check-pr-hygiene.mjs --base <sha> --head <sha>');
    process.exit(2);
  }
  const problems = findHygieneProblems({
    title: process.env.PR_TITLE ?? '',
    body: process.env.PR_BODY ?? '',
    commits: readCommits({ base, head }),
    addedLines: parseAddedLines(git(['diff', '--no-color', '--no-ext-diff', '-U0', `${base}...${head}`])),
  });
  if (problems.length === 0) {
    console.log('PR title, description, commit messages and added lines are clean.');
    return;
  }
  console.error('This pull request carries text that must not reach the public repository:');
  for (const problem of problems) {
    console.error(`- ${problem}`);
  }
  process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

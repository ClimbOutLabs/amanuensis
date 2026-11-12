#!/usr/bin/env node
// Fails (exit 1) when a pull request adds a TypeScript type assertion (`as T`, `<T>x`) or a non-null
// assertion (`x!`), which AGENTS.md forbids. `as const` stays allowed. Only lines the pull request
// adds are reported, so the check can run while older assertions are still being removed. An assertion
// counts as added when the line it starts on or the line it ends on is added: `<T>x` sits on the first,
// and `} as T` or `)!` closing a longer expression sits on the last. A changed file that does not parse
// fails the check wherever the error is, since nothing in it can be checked.
//
// Usage: node scripts/check-new-assertions.mjs --base <sha> --head <sha>

import { ESLint } from 'eslint';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import tseslint from 'typescript-eslint';
import { parseAddedLines } from './check-pr-hygiene.mjs';

// Generated code, and the vendored Gmail MCP fork under mcp/, whose lint config also allows its own
// non-null assertions so upstream syncs stay mechanical.
const NOT_OURS = [/^packages\/trueforge-sdk\//, /^mcp\//, /\.gen\.ts$/];
const TYPESCRIPT = /\.(?:ts|tsx|mts|cts)$/;

/**
 * The added TypeScript lines, grouped by file, that this check reads.
 * @param {{ file: string, line: number }[]} addedLines
 * @returns {Map<string, Set<number>>}
 */
export function addedTypeScriptLines(addedLines) {
  const byFile = new Map();
  for (const { file, line } of addedLines) {
    if (!TYPESCRIPT.test(file) || NOT_OURS.some(pattern => pattern.test(file))) {
      continue;
    }
    const lines = byFile.get(file) ?? new Set();
    lines.add(line);
    byFile.set(file, lines);
  }
  return byFile;
}

/**
 * Every assertion on an added line, as `file:line: message`.
 * @param {{ rootDir: string, linesByFile: Map<string, Set<number>> }} input
 * @returns {Promise<string[]>}
 */
export async function findNewAssertions({ rootDir, linesByFile }) {
  if (linesByFile.size === 0) {
    return [];
  }
  // Syntax only: these two rules need no type information, so no TypeScript project is built.
  const eslint = new ESLint({
    cwd: rootDir,
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ['**/*.{ts,tsx,mts,cts}'],
        languageOptions: { parser: tseslint.parser, parserOptions: { ecmaFeatures: { jsx: true } } },
        plugins: { '@typescript-eslint': tseslint.plugin },
        rules: {
          '@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'never' }],
          '@typescript-eslint/no-non-null-assertion': 'error',
        },
      },
    ],
    // Inline disable comments must not switch this rule off.
    allowInlineConfig: false,
  });
  const results = await eslint.lintFiles([...linesByFile.keys()].map(file => path.join(rootDir, file)));
  const problems = [];
  for (const result of results) {
    const file = path.relative(rootDir, result.filePath).split(path.sep).join('/');
    const added = linesByFile.get(file) ?? new Set();
    for (const message of result.messages) {
      if (message.fatal) {
        problems.push(`${file}:${message.line}: could not be read: ${message.message}`);
      } else {
        const endLine = message.endLine ?? message.line;
        const addedLine = added.has(message.line) ? message.line : added.has(endLine) ? endLine : undefined;
        if (addedLine !== undefined) {
          problems.push(`${file}:${addedLine}: ${message.message} Use a sound type, a guard or a schema instead.`);
        }
      }
    }
  }
  return problems;
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main() {
  const base = argValue('--base');
  const head = argValue('--head');
  if (!base || !head) {
    console.error('Usage: node scripts/check-new-assertions.mjs --base <sha> --head <sha>');
    process.exit(2);
  }
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const diff = execFileSync(
    'git',
    ['diff', '--no-color', '--no-ext-diff', '-U0', '--diff-filter=AMR', `${base}...${head}`],
    {
      cwd: rootDir,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    },
  );
  const problems = await findNewAssertions({ rootDir, linesByFile: addedTypeScriptLines(parseAddedLines(diff)) });
  if (problems.length === 0) {
    console.log('No added type or non-null assertions.');
    return;
  }
  console.error('This pull request adds assertions that AGENTS.md forbids:');
  for (const problem of problems) {
    console.error(`- ${problem}`);
  }
  process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

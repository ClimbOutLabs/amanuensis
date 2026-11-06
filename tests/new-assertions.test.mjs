import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { addedTypeScriptLines, findNewAssertions } from '../scripts/check-new-assertions.mjs';

async function withTree(files, run) {
  const rootDir = mkdtempSync(join(tmpdir(), 'new-assertions-'));
  try {
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(join(rootDir, file, '..'), { recursive: true });
      writeFileSync(join(rootDir, file), text);
    }
    return await run(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

const source = [
  "const a = JSON.parse('1') as number;",
  'const b = [1].find(x => x > 0)!;',
  'const c = { k: 1 } as const;',
  '// eslint-disable-next-line',
  "const d = JSON.parse('2') as number;",
  'export { a, b, c, d };',
].join('\n');

test('assertions on added lines fail, as const passes, and a disable comment does not hide one', async () => {
  await withTree({ 'packages/p/src/x.ts': source }, async rootDir => {
    const problems = await findNewAssertions({
      rootDir,
      linesByFile: new Map([['packages/p/src/x.ts', new Set([1, 2, 3, 4, 5])]]),
    });
    assert.deepEqual(
      problems.map(problem => problem.split(':').slice(0, 2).join(':')),
      ['packages/p/src/x.ts:1', 'packages/p/src/x.ts:2', 'packages/p/src/x.ts:5'],
    );
  });
});

test('assertions on lines the pull request did not add pass', async () => {
  await withTree({ 'packages/p/src/x.ts': source }, async rootDir => {
    const problems = await findNewAssertions({
      rootDir,
      linesByFile: new Map([['packages/p/src/x.ts', new Set([3, 6])]]),
    });
    assert.deepEqual(problems, []);
  });
});

test('only hand-written TypeScript is read', () => {
  const lines = addedTypeScriptLines([
    { file: 'packages/p/src/a.ts', line: 1 },
    { file: 'packages/p/src/b.tsx', line: 2 },
    { file: 'packages/p/tests/a.test.ts', line: 3 },
    { file: 'packages/trueforge-sdk/src/api.ts', line: 4 },
    { file: 'mcp/gmail/src/x.ts', line: 5 },
    { file: 'packages/p/src/catalog.gen.ts', line: 6 },
    { file: 'scripts/x.mjs', line: 7 },
  ]);
  assert.deepEqual([...lines.keys()], ['packages/p/src/a.ts', 'packages/p/src/b.tsx', 'packages/p/tests/a.test.ts']);
});

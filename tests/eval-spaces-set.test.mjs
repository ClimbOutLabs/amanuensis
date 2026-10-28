import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadSpaceSet, parseSpaceSet, SpaceSetError } from '../scripts/eval-spaces/parse.mjs';
import {
  countBoldLines,
  countDuplicates,
  countPictures,
  countRawListMarkers,
  countRows,
  failedExpectations,
  findRowsLost,
  isFormattingChanged,
  isTableValid,
  replyNamesSpace,
  rowKeys,
} from '../scripts/eval-spaces/score.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const realSetPath = path.join(rootDir, 'packages', 'trueforge', 'evals', 'space-set.json');
const fixtureSetPath = path.join(rootDir, 'tests', 'fixtures', 'eval-spaces', 'space-set.json');

function problemsOf(value) {
  try {
    parseSpaceSet(value);
  } catch (error) {
    assert.ok(error instanceof SpaceSetError, 'expected a SpaceSetError');
    return error.problems;
  }
  assert.fail('expected the set to be rejected');
}

const validPrompt = { id: 'a', prompt: 'Make a space.', expect: { rows: 2 } };

test('the shipped set holds the three acceptance prompts', async () => {
  const set = await loadSpaceSet(realSetPath);
  assert.deepEqual(
    set.prompts.map(prompt => prompt.id),
    ['dogs-40', 'nlv-dashboard', 'apartment-dogs-10'],
  );
  const dogs = set.prompts[0];
  assert.equal(
    dogs.prompt,
    'Make a space with the top 40 smartest dog breeds. For each breed give its temperament, exercise needs, and apartment friendliness, as a table.',
  );
  assert.equal(dogs.follow_up, 'Redo the formatting of that space so it reads well.');
  assert.deepEqual(dogs.expect, { rows: 40, duplicate_rows: 0, table_valid: true, formatting_changed: true });
  assert.deepEqual(set.prompts[1].expect, { completed: true, refused_or_failed_calls: 0 });
  assert.equal(set.prompts[2].follow_up, undefined);
  assert.deepEqual(set.prompts[2].expect, { rows: 10, duplicate_rows: 0, pictures_min: 1 });
});

test('the fixture set loads', async () => {
  const set = await loadSpaceSet(fixtureSetPath);
  assert.equal(set.prompts.length, 2);
});

test('a set must have version 1 and at least one prompt', () => {
  assert.ok(problemsOf({ version: 2, prompts: [validPrompt] }).some(problem => problem.includes('version')));
  assert.ok(problemsOf({ version: 1, prompts: [] }).some(problem => problem.includes('non-empty')));
  assert.ok(problemsOf([]).some(problem => problem.includes('JSON object')));
});

test('prompt problems are all listed', () => {
  const problems = problemsOf({
    version: 1,
    prompts: [
      validPrompt,
      { ...validPrompt },
      { id: 'b', prompt: ' ', expect: {} },
      { id: 'c', prompt: 'x', follow_up: '', expect: { rows: -1, mystery: 1, table_valid: 'yes' } },
      { id: 'd', prompt: 'x', expect: { formatting_changed: true } },
    ],
  });
  assert.ok(problems.some(problem => problem.includes('used more than once')));
  assert.ok(problems.some(problem => problem.includes('prompt must be a non-empty string')));
  assert.ok(problems.some(problem => problem.includes('at least one target')));
  assert.ok(problems.some(problem => problem.includes('follow_up must be')));
  assert.ok(problems.some(problem => problem.includes('expect.rows')));
  assert.ok(problems.some(problem => problem.includes('expect.mystery')));
  assert.ok(problems.some(problem => problem.includes('expect.table_valid')));
  assert.ok(problems.some(problem => problem.includes('needs a follow_up')));
});

const table = [
  '| # | Breed | Notes |',
  '| --- | --- | --- |',
  '| 1 | **Poodle** | calm |',
  '| 2 | `Collie` | alert |',
].join('\n');

test('markdown rows skip the header and separator, and keys skip rank cells', () => {
  const scored = { body: `Intro\n\n${table}\n\n| a |\n| --- |\n| Solo |`, format: 'markdown' };
  assert.equal(countRows(scored), 3);
  assert.deepEqual(rowKeys(scored), ['poodle', 'collie', 'solo']);
});

test('duplicates are found by key after stripping marks and case', () => {
  const body = ['| Breed | Notes |', '| --- | --- |', '| **Poodle** | a |', '| poodle | b |', '| _POODLE_ | c |'].join(
    '\n',
  );
  assert.equal(countDuplicates({ body, format: 'markdown' }), 2);
});

test('html rows ignore the header section', () => {
  const body =
    '<table><thead><tr><th>Breed</th></tr></thead><tbody><tr><td>1</td><td><b>Poodle</b></td></tr><tr><td>Collie</td></tr></tbody></table>';
  assert.equal(countRows({ body, format: 'html' }), 2);
  assert.deepEqual(rowKeys({ body, format: 'html' }), ['poodle', 'collie']);
  assert.equal(isTableValid({ body, format: 'html' }), true);
  assert.equal(isTableValid({ body: body.replace('</tbody>', '<tr></tbody>'), format: 'html' }), false);
});

test('a table is valid only with a separator and rows as wide as the header', () => {
  assert.equal(isTableValid({ body: table, format: 'markdown' }), true);
  assert.equal(isTableValid({ body: 'No table here.', format: 'markdown' }), false);
  assert.equal(isTableValid({ body: '| a | b |\n| x | y |', format: 'markdown' }), false);
  assert.equal(isTableValid({ body: '| a | b |\n| --- | --- |\n| x |', format: 'markdown' }), false);
});

test('formatting counts', () => {
  const body = '**Documents**\n- one\n* two\n1. three\n![dog](https://pics.example.test/a.png)\n<img src="b.png">';
  assert.equal(countBoldLines({ body }), 1);
  assert.equal(countRawListMarkers({ body }), 3);
  assert.equal(countPictures({ body }), 2);
});

test('a formatting change must be more than spacing', () => {
  assert.equal(isFormattingChanged({ before: 'a  b\n\nc', after: 'a b c ' }), false);
  assert.equal(isFormattingChanged({ before: 'a b c', after: '## a b c' }), true);
});

test('the closing line must name the space', () => {
  assert.equal(replyNamesSpace({ reply: 'I saved **Top Dogs** for you.', name: 'top dogs' }), true);
  assert.equal(replyNamesSpace({ reply: 'Done.', name: 'Top Dogs' }), false);
  assert.equal(replyNamesSpace({ reply: '', name: 'Top Dogs' }), false);
});

test('the revision walk names the first revision that lost a row', () => {
  const rev = (revision, keys) => ({
    revision,
    body: ['| Breed |', '| --- |', ...keys.map(key => `| ${key} |`)].join('\n'),
  });
  const format = 'markdown';
  assert.equal(findRowsLost({ revisions: [rev(1, ['a', 'b']), rev(2, ['a', 'b', 'c'])], format }), '');
  assert.equal(
    findRowsLost({ revisions: [rev(1, ['a', 'b']), rev(2, ['a', 'b', 'c']), rev(3, ['c', 'd'])], format }),
    'revision 3: a',
  );
  assert.equal(findRowsLost({ revisions: [], format }), '');
});

test('expectations report each missed target', () => {
  const measures = { rows: 38, duplicate_rows: 0, pictures: 0, table_valid: true };
  assert.deepEqual(
    failedExpectations({
      measures,
      expect: { rows: 40, duplicate_rows: 0, pictures_min: 1, table_valid: true, completed: true },
    }),
    ['rows 38 != 40', 'pictures 0 < 1', 'completed unknown != true'],
  );
  assert.deepEqual(failedExpectations({ measures, expect: { rows: 38 } }), []);
});

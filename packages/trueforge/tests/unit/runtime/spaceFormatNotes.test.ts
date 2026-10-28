import { spaceFormatNotes } from '../../../src/runtime/spaceFormatNotes';

const CLEAN_TABLE = ['| Breed | Size |', '| --- | --- |', '| Beagle | Small |', '| Poodle | Medium |'].join('\n');

function notesFor(body: string, format = 'markdown'): string[] {
  return spaceFormatNotes({ body, format });
}

describe('spaceFormatNotes', () => {
  it('is silent on a clean table', () => {
    expect(notesFor(`# Dogs\n\n${CLEAN_TABLE}\n\nThat is all.`)).toEqual([]);
  });

  it('is silent on html', () => {
    expect(notesFor('| a | b |\n| c |', 'html')).toEqual([]);
  });

  it('names a row whose cell count differs from the header', () => {
    const notes = notesFor(['| Breed | Size |', '| --- | --- |', '| Beagle | Small | Extra |'].join('\n'));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('line 3 has 3 cells, not 2');
  });

  it('names a header with no separator row', () => {
    const notes = notesFor(['Intro', '', '| Breed | Size |', '| Beagle | Small |'].join('\n'));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('line 3');
    expect(notes[0]).toContain('no separator row');
  });

  it('names a table split by a text line', () => {
    const notes = notesFor([CLEAN_TABLE, 'A stray remark.', '| Husky | Large |'].join('\n'));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('line 5');
    expect(notes[0]).toContain('cuts a table in two');
  });

  it('keeps two separate tables apart', () => {
    expect(
      notesFor(
        [CLEAN_TABLE, '', 'Next table.', '', CLEAN_TABLE.replace('Beagle', 'Akita').replace('Poodle', 'Pug')].join(
          '\n',
        ),
      ),
    ).toEqual([]);
  });

  it('names list markers inside a cell and not a dash in a range', () => {
    const marked = notesFor(['| Breed | Notes |', '| --- | --- |', '| Beagle | - loud<br>- friendly |'].join('\n'));
    expect(marked).toHaveLength(1);
    expect(marked[0]).toContain('lines 3');
    expect(marked[0]).toContain('use commas');
    expect(notesFor(['| Breed | Weight |', '| --- | --- |', '| Beagle | 10 - 15 kg |'].join('\n'))).toEqual([]);
  });

  it('flags bold on more than 40 percent of lines', () => {
    const body = ['**a**', '**b**', '**c**', 'd', 'e'].join('\n');
    expect(notesFor(body)).toEqual([expect.stringContaining('Bold is on 3 of 5 lines')]);
    expect(notesFor(['**a**', 'b', 'c', 'd', 'e'].join('\n'))).toEqual([]);
  });

  it('names duplicate rows', () => {
    const notes = notesFor(`${CLEAN_TABLE}\n| **Beagle** | Small |`);
    expect(notes).toEqual([expect.stringContaining('beagle')]);
  });

  it('returns at most five notes', () => {
    expect(notesFor('x').length).toBeLessThanOrEqual(5);
  });

  it('does not call rows with a repeated first cell duplicates', () => {
    const body = ['| Day | Time |', '| --- | --- |', '| Monday | 9am |', '| Monday | 2pm |'].join('\n');
    expect(notesFor(body)).toEqual([]);
  });

  it('does not compare keys across two tables', () => {
    const table = (heading: string) => `## ${heading}\n\n| Plan | Price |\n| --- | --- |\n| Basic | 5 |\n| Pro | 9 |`;
    expect(notesFor(`${table('Monthly')}\n\n${table('Yearly')}`)).toEqual([]);
  });

  it('ignores rows inside code fences', () => {
    const body = ['```', '| a | b |', '| a | b |', '```'].join('\n');
    expect(notesFor(body)).toEqual([]);
  });

  it('flags a whole row repeated inside one table', () => {
    const body = ['| Day | Time |', '| --- | --- |', '| Monday | 9am |', '| Monday | 9am |'].join('\n');
    expect(notesFor(body)).toEqual([expect.stringContaining('monday')]);
  });

  it('reads short separators and tables without a closing pipe', () => {
    expect(notesFor(['|a|b|', '|--|--|', '|1|2|'].join('\n'))).toEqual([]);
    expect(notesFor(['| a | b', '| - | -', '| 1 | 2'].join('\n'))).toEqual([]);
    const twoTables = ['## One', '| a | b |', '| - | - |', '| 1 | 2 |', '', '## Two', '|a|b|', '|--|--|', '|1|2|'].join(
      '\n',
    );
    expect(notesFor(twoTables)).toEqual([]);
  });

  it('does not count an escaped pipe as a cell edge', () => {
    const body = ['| Code | Kind |', '| --- | --- |', '| `a \\| b` | pipe |'].join('\n');
    expect(notesFor(body)).toEqual([]);
  });

  it('flags only dash, star, plus and bullet markers in a cell', () => {
    expect(notesFor(['| a | b |', '| - | - |', '| 1. one | 2) two |'].join('\n'))).toEqual([]);
  });

  it('does not count table rows toward the bold share', () => {
    const rows = Array.from({ length: 8 }, (_, i) => `| **n${String(i)}** | x |`);
    const body = ['| a | b |', '| --- | --- |', ...rows, 'Plain.', 'Plain.', 'Plain.', 'Plain.', 'Plain.'].join('\n');
    expect(notesFor(body)).toEqual([]);
  });
});

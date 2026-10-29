import {
  isTableRow,
  isTableSeparatorRow,
  orphanedRowGroupCount,
  rowCells,
  rowNameCell,
  tableRowEntries,
} from '../../../src/runtime/spaceTableRows';

const keysOf = (content: string): string[] => tableRowEntries(content).map(entry => entry.key);

describe('table row parsing', () => {
  it('recognises rows and separators', () => {
    expect(isTableRow('  | a | b |  ')).toBe(true);
    expect(isTableRow('a | b')).toBe(false);
    expect(isTableSeparatorRow('| --- | :---: |')).toBe(true);
    expect(isTableSeparatorRow('| a | --- |')).toBe(false);
    expect(isTableSeparatorRow('---')).toBe(false);
    expect(isTableSeparatorRow('|-|-|')).toBe(true);
    expect(isTableSeparatorRow('|:--|:--')).toBe(true);
    expect(isTableRow('| 1 | Papillon')).toBe(true);
    expect(keysOf('| Rank | Breed\n| --- | ---\n| 1 | Papillon')).toEqual(['papillon']);
    expect(isTableSeparatorRow('| --- | |')).toBe(true);
    expect(isTableSeparatorRow('| |')).toBe(false);
  });

  it('keys a row by its first cell, skipping a rank cell', () => {
    expect(keysOf('| **Papillon** | small |')).toEqual(['papillon']);
    expect(keysOf('| 3. | `Beagle` | hound |')).toEqual(['beagle']);
    expect(keysOf('| #4 | _Poodle_ |')).toEqual(['poodle']);
    expect(keysOf('| --- | --- |')).toEqual([]);
    expect(keysOf('plain text')).toEqual([]);
    expect(keysOf('|  | x |')).toEqual([]);
  });

  it('splits trimmed cells and names a row by its first cell, or its second after a rank', () => {
    expect(rowCells('| a | b \\| c |')).toEqual(['a', 'b \\| c']);
    expect(rowCells('| a | b')).toEqual(['a', 'b']);
    expect(rowNameCell('| 3. | **Beagle** | hound |')).toBe('**Beagle**');
    expect(rowNameCell('| Poodle | toy |')).toBe('Poodle');
    expect(rowNameCell('| --- | --- |')).toBeNull();
    expect(rowNameCell('plain text')).toBeNull();
  });

  it('lists data row keys without the header', () => {
    const content = ['| Rank | Breed |', '| --- | --- |', '| 1 | Papillon |', '| 2 | Beagle |'].join('\n');
    expect(keysOf(content)).toEqual(['papillon', 'beagle']);
    expect(keysOf('| 5 | Collie |\n| 6 | Pug |')).toEqual(['collie', 'pug']);
  });
});

describe('table row labels and groups', () => {
  it('labels a row with the whole row as written', () => {
    expect(tableRowEntries('| 1 | **Papillon** | x |')).toEqual([
      { key: 'papillon', label: '| 1 | **Papillon** | x |' },
    ]);
  });

  it('skips lines inside code fences', () => {
    expect(keysOf('```\n| grep error\n```\n| a | b |')).toEqual(['a']);
  });

  it('counts row groups that have no separator', () => {
    expect(orphanedRowGroupCount('| a |\n| b |\n\ntext\n\n| H |\n| --- |\n| c |')).toBe(1);
    expect(orphanedRowGroupCount('```\n| grep x\n```')).toBe(0);
  });
});

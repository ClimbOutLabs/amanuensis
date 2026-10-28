import {
  isTableRow,
  isTableSeparatorRow,
  orphanedRowGroupCount,
  tableRowEntries,
  tableRowKey,
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
    expect(tableRowKey('| **Papillon** | small |')).toBe('papillon');
    expect(tableRowKey('| 3. | `Beagle` | hound |')).toBe('beagle');
    expect(tableRowKey('| #4 | _Poodle_ |')).toBe('poodle');
    expect(tableRowKey('| --- | --- |')).toBeNull();
    expect(tableRowKey('plain text')).toBeNull();
    expect(tableRowKey('|  | x |')).toBeNull();
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

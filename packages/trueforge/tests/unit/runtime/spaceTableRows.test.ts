import {
  isTableRow,
  isTableSeparatorRow,
  tableRowEntries,
  tableRowKey,
  tableRowKeys,
} from '../../../src/runtime/spaceTableRows';

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
    expect(tableRowKeys('| Rank | Breed\n| --- | ---\n| 1 | Papillon')).toEqual(['papillon']);
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
    expect(tableRowKeys(content)).toEqual(['papillon', 'beagle']);
    expect(tableRowKeys('| 5 | Collie |\n| 6 | Pug |')).toEqual(['collie', 'pug']);
  });
});

describe('table row labels', () => {
  it('keeps the key cell as written, without markup', () => {
    expect(tableRowEntries('| 1 | **Papillon** | x |')).toEqual([{ key: 'papillon', label: 'Papillon' }]);
  });
});

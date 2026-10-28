const SEPARATOR_CELL = /^\s*:?-+:?\s*$/;
const RANK_CELL = /^\s*#?\d+\.?\s*$/;

/** The cells of a table row: split on unescaped pipes, empty edge cells dropped, each trimmed. */
export function rowCells(line: string): string[] {
  const cells = line.trim().split(/(?<!\\)\|/);
  if (cells[0] === '') {
    cells.shift();
  }
  if (cells[cells.length - 1] === '') {
    cells.pop();
  }
  return cells.map(cell => cell.trim());
}

export function isTableRow(line: string): boolean {
  return line.trim().startsWith('|');
}

export function isTableSeparatorRow(line: string): boolean {
  const cells = rowCells(line);
  return isTableRow(line) && cells.length > 0 && cells.every(cell => SEPARATOR_CELL.test(cell));
}

/** The comparison key of one data row: its name cell, skipping a leading rank number. */
export function tableRowKey(line: string): string | null {
  if (!isTableRow(line) || isTableSeparatorRow(line)) {
    return null;
  }
  const cells = rowCells(line);
  const first = cells[0] ?? '';
  const keyCell = RANK_CELL.test(first) ? (cells[1] ?? '') : first;
  const key = keyCell.replace(/[*_`]/g, '').trim().toLowerCase();
  return key === '' ? null : key;
}

/** Keys of the data rows in order; the header is the row directly above a separator. */
export function tableRowKeys(content: string): string[] {
  const lines = content.split('\n');
  const keys: string[] = [];
  for (const [index, line] of lines.entries()) {
    const isHeader = isTableSeparatorRow(lines[index + 1] ?? '') && isTableRow(line);
    if (isHeader) {
      continue;
    }
    const key = tableRowKey(line);
    if (key !== null) {
      keys.push(key);
    }
  }
  return keys;
}

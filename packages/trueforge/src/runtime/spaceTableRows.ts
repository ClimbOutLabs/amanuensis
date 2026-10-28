const SEPARATOR_CELL = /^\s*:?-{3,}:?\s*$/;
const RANK_CELL = /^\s*#?\d+\.?\s*$/;

function cellsOf(line: string): string[] {
  const trimmed = line.trim();
  return trimmed.slice(1, trimmed.length - 1).split('|');
}

/** A markdown table row: the trimmed line starts and ends with a pipe. */
export function isTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.length >= 2 && trimmed.startsWith('|') && trimmed.endsWith('|');
}

export function isTableSeparatorRow(line: string): boolean {
  return isTableRow(line) && cellsOf(line).every(cell => SEPARATOR_CELL.test(cell));
}

/**
 * The name a row goes by: its first cell, or its second when the first only numbers the row.
 * Null for a line that is not a data row, or whose key cell is empty.
 */
export function tableRowKey(line: string): string | null {
  if (!isTableRow(line) || isTableSeparatorRow(line)) {
    return null;
  }
  const [first, second] = cellsOf(line);
  const keyCell = first !== undefined && RANK_CELL.test(first) && second !== undefined ? second : first;
  const key = (keyCell ?? '').replace(/[*_`]/g, '').trim().toLowerCase();
  return key === '' ? null : key;
}

/** Keys of the data rows in order. The header is the row directly above a separator row. */
export function tableRowKeys(content: string): string[] {
  const lines = content.split('\n');
  const keys: string[] = [];
  lines.forEach((line, index) => {
    const isHeader = index + 1 < lines.length && isTableRow(line) && isTableSeparatorRow(lines[index + 1] ?? '');
    const key = isHeader ? null : tableRowKey(line);
    if (key !== null) {
      keys.push(key);
    }
  });
  return keys;
}

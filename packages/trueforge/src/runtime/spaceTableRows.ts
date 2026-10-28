const SEPARATOR_CELL = /^:?-+:?$/;
const RANK_CELL = /^\s*#?\d+\.?\s*$/;

/** The trimmed cells of a row: split on unescaped pipes, with the empty edge cells dropped. */
export function rowCells(line: string): string[] {
  const parts = line.trim().split(/(?<!\\)\|/);
  parts.shift();
  if (parts.length > 0 && (parts[parts.length - 1] ?? '').trim() === '') {
    parts.pop();
  }
  return parts.map(cell => cell.trim());
}

/** A markdown table row: the trimmed line starts with a pipe; the closing pipe is optional. */
export function isTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.length >= 2 && trimmed.startsWith('|');
}

export function isTableSeparatorRow(line: string): boolean {
  if (!isTableRow(line)) {
    return false;
  }
  const cells = rowCells(line);
  return cells.length > 0 && cells.every(cell => SEPARATOR_CELL.test(cell));
}

/**
 * The name a row goes by: its first cell, or its second when the first only numbers the row.
 * Null for a line that is not a data row, or whose key cell is empty.
 */
export function tableRowKey(line: string): string | null {
  if (!isTableRow(line) || isTableSeparatorRow(line)) {
    return null;
  }
  const [first, second] = rowCells(line);
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

const SEPARATOR_CELL = /^\s*:?-{3,}:?\s*$/;
const RANK_CELL = /^\s*#?\d+\.?\s*$/;

/** A markdown table row: the trimmed line starts and ends with a pipe. */
export function isTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.length >= 2 && trimmed.startsWith('|') && trimmed.endsWith('|');
}

/** The row under a header that holds only dashes, with optional colons for alignment. */
export function isTableSeparatorRow(line: string): boolean {
  return isTableRow(line) && tableCells(line).every(cell => SEPARATOR_CELL.test(cell));
}

function tableCells(line: string): string[] {
  return line.trim().slice(1, -1).split('|');
}

/**
 * The text that names a data row: its first cell, or its second when the first is only a
 * number or rank. Null for lines that are not data rows.
 */
export function tableRowKey(line: string): string | null {
  if (!isTableRow(line) || isTableSeparatorRow(line)) {
    return null;
  }
  const [first, second] = tableCells(line);
  const cell = first !== undefined && RANK_CELL.test(first) && second !== undefined ? second : first;
  const key = (cell ?? '').replace(/[*_`]/g, '').trim().toLowerCase();
  return key.length === 0 ? null : key;
}

/** Keys of the data rows of a body, in order; a header (the row above a separator) is not a data row. */
export function tableRowKeys(content: string): string[] {
  const lines = content.split('\n');
  const keys: string[] = [];
  for (const [index, line] of lines.entries()) {
    const isHeader = isTableRow(line) && isTableSeparatorRow(lines[index + 1] ?? '');
    const key = isHeader ? null : tableRowKey(line);
    if (key !== null) {
      keys.push(key);
    }
  }
  return keys;
}

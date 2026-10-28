const SEPARATOR_CELL = /^\s*:?-{3,}:?\s*$/;
const RANK_CELL = /^\s*#?\d+\.?\s*$/;

function cellsOf(line: string): string[] {
  const trimmed = line.trim();
  return trimmed.slice(1, -1).split(/(?<!\\)\|/);
}

export function isTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.length >= 2 && trimmed.startsWith('|') && trimmed.endsWith('|');
}

export function isTableSeparatorRow(line: string): boolean {
  return isTableRow(line) && cellsOf(line).every(cell => SEPARATOR_CELL.test(cell));
}

/** The comparison key of one data row: its name cell, skipping a leading rank number. */
export function tableRowKey(line: string): string | null {
  if (!isTableRow(line) || isTableSeparatorRow(line)) {
    return null;
  }
  const cells = cellsOf(line);
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

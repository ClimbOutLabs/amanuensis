/** Markdown table row parsing shared by the space edit checks. */

const SEPARATOR_CELL = /^\s*:?-{3,}:?\s*$/;
const RANK_CELL = /^\s*#?\d+\.?\s*$/;

export function isTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.length >= 2 && trimmed.startsWith('|') && trimmed.endsWith('|');
}

function rowCells(line: string): string[] {
  const inner = line.trim().slice(1, -1);
  return inner.split(/(?<!\\)\|/);
}

export function isTableSeparatorRow(line: string): boolean {
  return isTableRow(line) && rowCells(line).every(cell => SEPARATOR_CELL.test(cell));
}

/** The row's identity: its first cell, or its second when the first is only a number or rank. */
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
    if (isTableRow(lines[index + 1] ?? '') && isTableSeparatorRow(lines[index + 1] ?? '')) {
      continue;
    }
    const key = tableRowKey(line);
    if (key !== null) {
      keys.push(key);
    }
  }
  return keys;
}

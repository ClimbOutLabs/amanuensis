/** Markdown table row parsing: the one owner of row and separator detection for space bodies. */

const SEPARATOR_CELL = /^\s*:?-+:?\s*$/;
const RANK_CELL = /^\s*#?\d+\.?\s*$/;

/** A row is any line that starts with a pipe; the closing pipe is optional. */
export function isTableRow(line: string): boolean {
  return line.trim().startsWith('|');
}

function rowCells(line: string): string[] {
  const trimmed = line.trim().slice(1);
  const inner = trimmed.endsWith('|') ? trimmed.slice(0, -1) : trimmed;
  return inner.split(/(?<!\\)\|/);
}

export function isTableSeparatorRow(line: string): boolean {
  return isTableRow(line) && rowCells(line).every(cell => SEPARATOR_CELL.test(cell));
}

/** The cell that identifies a row as written: its first cell, or its second when the first is a rank. */
function keyCellOf(line: string): string | null {
  if (!isTableRow(line) || isTableSeparatorRow(line)) {
    return null;
  }
  const cells = rowCells(line);
  const first = cells[0] ?? '';
  return (RANK_CELL.test(first) ? (cells[1] ?? '') : first).trim();
}

function normalizeKey(cell: string): string {
  return cell.replace(/[*_`]/g, '').trim().toLowerCase();
}

export function tableRowKey(line: string): string | null {
  const cell = keyCellOf(line);
  const key = cell === null ? '' : normalizeKey(cell);
  return key === '' ? null : key;
}

/** Data rows in order, with each row's key cell as written; the header is the row above a separator. */
export function tableRowEntries(content: string): { key: string; label: string }[] {
  const lines = content.split('\n');
  const entries: { key: string; label: string }[] = [];
  for (const [index, line] of lines.entries()) {
    if (isTableSeparatorRow(lines[index + 1] ?? '')) {
      continue;
    }
    const key = tableRowKey(line);
    if (key !== null) {
      entries.push({ key, label: (keyCellOf(line) ?? key).replace(/[*_`]/g, '').trim() });
    }
  }
  return entries;
}

export function tableRowKeys(content: string): string[] {
  return tableRowEntries(content).map(entry => entry.key);
}

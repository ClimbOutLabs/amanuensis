import { maskDocumentationRegions } from './spaceDocumentationMask';

/** Markdown table row parsing: the one owner of row and separator detection for space bodies. */

const SEPARATOR_CELL = /^\s*:?-+:?\s*$/;
const MARKUP = /[*_`]/g;
/** A cell that only numbers the row, such as `3`, `3.` or `#3`. */
export const RANK_CELL = /^\s*#?\d+\.?\s*$/;

/** A row is any line that starts with a pipe; the closing pipe is optional. */
export function isTableRow(line: string): boolean {
  return line.trim().startsWith('|');
}

/** The trimmed cells of a row: split on unescaped pipes, without the edge pipes. */
export function rowCells(line: string): string[] {
  const trimmed = line.trim().slice(1);
  const inner = trimmed.endsWith('|') ? trimmed.slice(0, -1) : trimmed;
  return inner.split(/(?<!\\)\|/).map(cell => cell.trim());
}

export function isTableSeparatorRow(line: string): boolean {
  return isTableRow(line) && separatorCells(line);
}

/** Every cell is a dash run or empty, and at least one has dashes. */
function separatorCells(line: string): boolean {
  const cells = rowCells(line);
  return (
    cells.some(cell => SEPARATOR_CELL.test(cell)) &&
    cells.every(cell => cell.trim() === '' || SEPARATOR_CELL.test(cell))
  );
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
  return cell.replace(MARKUP, '').trim().toLowerCase();
}

export function tableRowKey(line: string): string | null {
  const cell = keyCellOf(line);
  const key = cell === null ? '' : normalizeKey(cell);
  return key === '' ? null : key;
}

/**
 * Data rows in order, each with its whole row as written; the header is the row above a separator.
 * Lines inside code fences are text, not rows.
 */
export function tableRowEntries(content: string): { key: string; label: string }[] {
  const lines = maskDocumentationRegions(content).split('\n');
  const originals = content.split('\n');
  const entries: { key: string; label: string }[] = [];
  for (const [index, line] of lines.entries()) {
    if (isTableSeparatorRow(lines[index + 1] ?? '')) {
      continue;
    }
    const key = tableRowKey(line);
    if (key !== null) {
      entries.push({ key, label: (originals[index] ?? line).trim() });
    }
  }
  return entries;
}

/** Runs of consecutive table rows that have no separator row: row groups with no header. */
export function orphanedRowGroupCount(content: string): number {
  let orphans = 0;
  let inRun = false;
  let hasSeparator = false;
  const close = (): void => {
    if (inRun && !hasSeparator) {
      orphans += 1;
    }
    inRun = false;
    hasSeparator = false;
  };
  for (const line of maskDocumentationRegions(content).split('\n')) {
    if (!isTableRow(line)) {
      close();
      continue;
    }
    inRun = true;
    hasSeparator ||= isTableSeparatorRow(line);
  }
  close();
  return orphans;
}

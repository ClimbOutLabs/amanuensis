import { codeFenceRoles } from './spaceDocumentationMask';
import { isTableRow, isTableSeparatorRow, rowCells, rowNameCell } from './spaceTableRows';

export interface SkippedRow {
  /** The row's name cell as written. */
  key: string;
  /** 1-based position among the data rows of the table in the call. */
  row: number;
}

const WHOLE_CELL_EMPHASIS = /^(\*\*|__|\*|_)(.+)\1$/;

/**
 * The identity of a data row: all its cells, case-sensitive, with whitespace collapsed and
 * emphasis that wraps a whole cell removed. Two rows count as the same only when every cell
 * matches, so a silent drop can never lose a distinct row. Null for non-rows and separators.
 */
export function duplicateRowKey(line: string): string | null {
  if (!isTableRow(line) || isTableSeparatorRow(line)) {
    return null;
  }
  const cells = rowCells(line).map(cell => {
    const collapsed = cell.replace(/\s+/g, ' ');
    return collapsed.replace(WHOLE_CELL_EMPHASIS, '$2');
  });
  return cells.every(cell => cell === '') ? null : JSON.stringify(cells);
}

/**
 * Row keys of the table that ends at the end of `text`, so rows a call adds can be compared
 * with what is already saved. Null when the text ends inside a code fence. A run with no
 * separator has no known header, so its first row is left out rather than counted as data.
 */
export function keysOfTableEndingAt(text: string): string[] | null {
  const lines = text.split('\n');
  const last = codeFenceRoles(lines).at(-1);
  if (last === 'open' || last === 'inside') {
    return null;
  }
  let start = lines.length;
  while (start > 0 && isTableRow(lines[start - 1] ?? '')) {
    start -= 1;
  }
  const run = lines.slice(start);
  const hasSeparator = run.some(isTableSeparatorRow);
  const keys: string[] = [];
  for (const [index, line] of run.entries()) {
    const isHeader = isTableSeparatorRow(run[index + 1] ?? '') || (!hasSeparator && index === 0);
    const key = isHeader ? null : duplicateRowKey(line);
    if (key !== null) {
      keys.push(key);
    }
  }
  return keys;
}

/**
 * Drops data rows that repeat an earlier row of the same table in `content`, and rows of
 * its first table that match `existingKeys`. Headers, separators and code fences are never
 * compared.
 */
export function dropDuplicateRows({ content, existingKeys }: { content: string; existingKeys: readonly string[] }): {
  content: string;
  skipped: SkippedRow[];
} {
  const lines = content.split('\n');
  const kept: string[] = [];
  const skipped: SkippedRow[] = [];
  let seen: Set<string> | null = null;
  let firstTable = true;
  const roles = codeFenceRoles(lines);
  let row = 0;
  for (const [index, line] of lines.entries()) {
    if (roles[index] !== 'outside' || !isTableRow(line)) {
      seen = null;
      kept.push(line);
      continue;
    }
    if (seen === null) {
      seen = new Set(firstTable ? existingKeys : []);
      firstTable = false;
      row = 0;
    }
    if (isTableSeparatorRow(line) || isTableSeparatorRow(lines[index + 1] ?? '')) {
      kept.push(line);
      continue;
    }
    row += 1;
    const key = duplicateRowKey(line);
    if (key !== null && seen.has(key)) {
      skipped.push({ key: rowNameCell(line) ?? line.trim(), row });
      continue;
    }
    if (key !== null) {
      seen.add(key);
    }
    kept.push(line);
  }
  return { content: skipped.length === 0 ? content : kept.join('\n'), skipped };
}

/**
 * The rows `dropDuplicateRows` skips in `content` before the point where `kept`, a leading
 * part of its output, ends: a write cut short names only the skips in the part it saved.
 */
export function skippedRowsWithin({ content, kept }: { content: string; kept: string }): SkippedRow[] {
  const lines = content.split('\n');
  const keptLines = kept.split('\n');
  // The output keeps lines in order, so the saved part ends at the line that matches its last line.
  let matched = 0;
  let end = 0;
  while (end < lines.length && matched < keptLines.length) {
    if (lines[end] === keptLines[matched]) {
      matched += 1;
    }
    end += 1;
  }
  return dropDuplicateRows({ content: lines.slice(0, end).join('\n'), existingKeys: [] }).skipped;
}

export function skippedRowsSentence(skipped: readonly SkippedRow[]): string {
  const count = skipped.length;
  const named = skipped.map(({ key, row }) => `"${key}" (row ${String(row)} of this call)`).join(', ');
  const noun = count === 1 ? '1 row that was' : `${String(count)} rows that were`;
  return `Skipped ${noun} already in the table: ${named}.`;
}

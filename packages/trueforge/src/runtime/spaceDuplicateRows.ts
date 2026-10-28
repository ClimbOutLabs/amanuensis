import { isTableRow, isTableSeparatorRow, tableRowKey, tableRowKeys } from './spaceTableRows';

export interface SkippedRow {
  key: string;
  /** 1-based position among the data rows of the table in the call. */
  row: number;
}

/** Keys of the table that ends at the end of `text`, so new rows can be compared with it. */
export function keysOfTableEndingAt(text: string): string[] {
  const lines = text.split('\n');
  let start = lines.length;
  while (start > 0 && isTableRow(lines[start - 1] ?? '')) {
    start -= 1;
  }
  return tableRowKeys(lines.slice(start).join('\n'));
}

/**
 * Drops data rows whose key repeats inside one table of `content`, and rows of its first
 * table whose key is in `existingKeys`. Headers and separators are never compared.
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
  let row = 0;
  for (const [index, line] of lines.entries()) {
    if (!isTableRow(line)) {
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
    const key = tableRowKey(line);
    if (key !== null && seen.has(key)) {
      skipped.push({ key, row });
      continue;
    }
    if (key !== null) {
      seen.add(key);
    }
    kept.push(line);
  }
  return { content: skipped.length === 0 ? content : kept.join('\n'), skipped };
}

export function skippedRowsSentence(skipped: readonly SkippedRow[]): string {
  const count = skipped.length;
  const named = skipped.map(({ key, row }) => `"${key}" (row ${String(row)})`).join(', ');
  const noun = count === 1 ? '1 row that was' : `${String(count)} rows that were`;
  return `Skipped ${noun} already in the table: ${named}.`;
}

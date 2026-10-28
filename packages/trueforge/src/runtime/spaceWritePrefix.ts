import { isTableRow, isTableSeparatorRow } from './spaceTableRows';

const UNSAVED_PREVIEW_LENGTH = 80;

export interface WritePrefix {
  kept: string;
  saved_lines: number;
  unsaved_lines: number;
  /** The first unsaved line, cut to 80 characters, so the model knows where to continue. */
  unsaved_from: string;
}

function countNonBlank(lines: readonly string[]): number {
  return lines.filter(line => line.trim() !== '').length;
}

/**
 * The longest run of whole leading lines of `content` that fits `cap`, so an over-size
 * write can save what fits instead of being thrown away. Null when no useful prefix
 * exists: fewer than two lines fit, or a line is longer than the cap and could never be
 * saved in any part. A table header is never kept without a data row under it.
 */
export function prefixWithinCap({ content, cap }: { content: string; cap: number }): WritePrefix | null {
  const lines = content.split('\n');
  if (lines.some(line => line.length > cap)) {
    return null;
  }
  let keepCount = 0;
  let length = 0;
  for (const [index, line] of lines.entries()) {
    const next = index === 0 ? line.length : length + 1 + line.length;
    if (next > cap) {
      break;
    }
    length = next;
    keepCount = index + 1;
  }
  const lastKept = lines[keepCount - 1] ?? '';
  if (isTableSeparatorRow(lastKept)) {
    keepCount -= 2;
  } else if (isTableRow(lastKept) && isTableSeparatorRow(lines[keepCount] ?? '')) {
    keepCount -= 1;
  }
  while (keepCount > 0 && (lines[keepCount - 1] ?? '').trim() === '') {
    keepCount -= 1;
  }
  const keptLines = lines.slice(0, keepCount);
  const unsavedLines = lines.slice(keepCount);
  const saved_lines = countNonBlank(keptLines);
  const firstUnsaved = unsavedLines.find(line => line.trim() !== '');
  if (saved_lines < 2 || firstUnsaved === undefined) {
    return null;
  }
  return {
    kept: keptLines.join('\n'),
    saved_lines,
    unsaved_lines: countNonBlank(unsavedLines),
    unsaved_from: firstUnsaved.trim().slice(0, UNSAVED_PREVIEW_LENGTH),
  };
}

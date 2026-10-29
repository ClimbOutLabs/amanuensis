import { codeFenceRoles } from './spaceDocumentationMask';
import { isTableRow, isTableSeparatorRow } from './spaceTableRows';

const UNSAVED_PREVIEW_LENGTH = 80;

export interface WritePrefix {
  kept: string;
  saved_lines: number;
  unsaved_lines: number;
  /** The first unsaved line, cut to 80 characters, so the model knows where to continue. */
  unsaved_from: string;
}

const HTML_BLOCK_TAG = /<(\/?)(div|table|details|pre|ul|ol|section|blockquote)\b[^>]*>/gi;

/**
 * The line where a fence or an html block opened and was not closed by the end of the
 * first `count` lines, or null when the lines end outside any. Cutting there would hand
 * the page an unclosed block, so the cut steps back to before it.
 */
function openBlockStart(lines: readonly string[], count: number): number | null {
  const roles = codeFenceRoles(lines.slice(0, count));
  let fenceStart: number | null = null;
  let htmlStart: number | null = null;
  let htmlDepth = 0;
  for (let index = 0; index < count; index += 1) {
    const line = lines[index] ?? '';
    const role = roles[index] ?? 'outside';
    if (role === 'open') {
      fenceStart = index;
    } else if (role === 'close') {
      fenceStart = null;
    }
    if (role !== 'outside') {
      continue;
    }
    for (const match of line.matchAll(HTML_BLOCK_TAG)) {
      if (match[1] === '/') {
        htmlDepth = Math.max(0, htmlDepth - 1);
      } else {
        htmlStart = htmlDepth === 0 ? index : htmlStart;
        htmlDepth += 1;
      }
    }
  }
  const starts = [fenceStart, htmlDepth > 0 ? htmlStart : null].filter(start => start !== null);
  return starts.length === 0 ? null : Math.min(...starts);
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
  keepCount = openBlockStart(lines, keepCount) ?? keepCount;
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

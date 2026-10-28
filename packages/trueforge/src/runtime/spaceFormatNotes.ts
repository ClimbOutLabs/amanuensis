import { duplicateRowKey } from './spaceDuplicateRows';
import { isTableRow, isTableSeparatorRow, rowCells, rowNameCell } from './spaceTableRows';

const MAX_NOTES = 5;
const MAX_NAMED = 3;
const BOLD_SHARE_LIMIT = 0.4;
const BOLD_MIN_LINES = 5;
const MAX_TEXT_LINES_IN_A_SPLIT = 2;
const BOLD_SPAN = /\*\*[^*]+\*\*/;
const LIST_MARKER_AT_CELL_START = /(?:^|<br\s*\/?>)\s*[-*+•]\s+\S/i;

interface TableGroup {
  /** Zero-based index of the group's first line. */
  start: number;
  lines: string[];
}

function named(items: string[]): string {
  const shown = items.slice(0, MAX_NAMED).join(', ');
  return items.length > MAX_NAMED ? `${shown} and ${String(items.length - MAX_NAMED)} more` : shown;
}

/** Runs of table rows outside fenced code, with their position. */
function tableGroups(lines: string[]): TableGroup[] {
  const groups: TableGroup[] = [];
  let fenced = false;
  let open: TableGroup | undefined;
  lines.forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
    }
    if (!fenced && isTableRow(line)) {
      if (open === undefined) {
        open = { start: index, lines: [] };
        groups.push(open);
      }
      open.lines.push(line);
    } else {
      open = undefined;
    }
  });
  return groups;
}

/**
 * Plain sentences about how a markdown body will render, for the model to fix with a
 * follow-up edit. Empty when the body is clean or not markdown.
 */
export function spaceFormatNotes({ body, format }: { body: string; format: string }): string[] {
  if (format !== 'markdown') {
    return [];
  }
  const lines = body.split('\n');
  const groups = tableGroups(lines);
  const notes: string[] = [];

  const ragged: string[] = [];
  const headless: string[] = [];
  const split: string[] = [];
  const bulleted: string[] = [];
  let previous: TableGroup | undefined;
  for (const group of groups) {
    const hasHeader = group.lines.length > 1 && isTableSeparatorRow(group.lines[1] ?? '');
    const width = hasHeader ? rowCells(group.lines[0] ?? '').length : 0;
    group.lines.forEach((line, offset) => {
      const lineNumber = group.start + offset + 1;
      if (hasHeader && offset > 1 && rowCells(line).length !== width) {
        ragged.push(`line ${String(lineNumber)} has ${String(rowCells(line).length)} cells, not ${String(width)}`);
      }
      if (rowCells(line).some(cell => LIST_MARKER_AT_CELL_START.test(cell))) {
        bulleted.push(String(lineNumber));
      }
    });
    if (!hasHeader) {
      const gap = previous === undefined ? [] : lines.slice(previous.start + previous.lines.length, group.start);
      const textInGap = gap.filter(line => line.trim() !== '');
      const continuesTable =
        previous !== undefined && textInGap.length > 0 && textInGap.length <= MAX_TEXT_LINES_IN_A_SPLIT;
      if (continuesTable) {
        const firstText = gap.findIndex(line => line.trim() !== '');
        split.push(`line ${String((previous?.start ?? 0) + (previous?.lines.length ?? 0) + firstText + 1)}`);
      } else if (group.lines.length > 1) {
        headless.push(`line ${String(group.start + 1)}`);
      }
    }
    previous = group;
  }

  if (ragged.length > 0) {
    notes.push(`Some table rows do not match the header: ${named(ragged)}. Give each row the same number of cells.`);
  }
  if (headless.length > 0) {
    notes.push(
      `The table at ${named(headless)} has no separator row under its header, so it shows as plain text. Add a row of dashes such as | --- | --- |.`,
    );
  }
  if (split.length > 0) {
    notes.push(
      `A line of text at ${named(split)} cuts a table in two, and the rows after it lose their header. Move the text out of the table.`,
    );
  }
  if (bulleted.length > 0) {
    notes.push(
      `Table rows on lines ${named(bulleted)} show list markers inside a cell, and a cell shows them as plain text; use commas.`,
    );
  }

  const textLines = lines.filter(line => line.trim() !== '' && !isTableRow(line));
  const boldLines = textLines.filter(line => BOLD_SPAN.test(line)).length;
  if (textLines.length >= BOLD_MIN_LINES && boldLines / textLines.length > BOLD_SHARE_LIMIT) {
    notes.push(
      `Bold is on ${String(boldLines)} of ${String(textLines.length)} lines, so nothing stands out. Keep bold for the few words that matter.`,
    );
  }

  // The same row identity the duplicate drop uses, so a note never flags a row it would keep.
  const repeated = new Set<string>();
  for (const group of groups) {
    const seen = new Set<string>();
    group.lines.forEach((line, offset) => {
      if (isTableSeparatorRow(group.lines[offset + 1] ?? '')) {
        return;
      }
      const key = duplicateRowKey(line);
      if (key === null) {
        return;
      }
      if (seen.has(key)) {
        repeated.add(rowNameCell(line) ?? line.trim());
      }
      seen.add(key);
    });
  }
  if (repeated.size > 0) {
    notes.push(`These table rows appear more than once: ${named([...repeated])}. Keep one row of each.`);
  }

  return notes.slice(0, MAX_NOTES);
}

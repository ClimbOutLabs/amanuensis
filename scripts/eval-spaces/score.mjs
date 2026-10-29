// Pure scoring of a stored space body. No network: the runner fetches, this module counts.

const SEPARATOR_CELL = /^\s*:?-{3,}:?\s*$/;
const RANK_CELL = /^\s*#?\d+\.?\s*$/;

function isTableLine(line) {
  const trimmed = line.trim();
  return trimmed.length >= 2 && trimmed.startsWith('|') && trimmed.endsWith('|');
}

function cellsOf(line) {
  // An escaped pipe (\\|) belongs to the cell text.
  return line
    .trim()
    .slice(1, -1)
    .split(/(?<!\\)\|/);
}

function isSeparatorLine(line) {
  return isTableLine(line) && cellsOf(line).every(cell => SEPARATOR_CELL.test(cell));
}

/** Tables are runs of consecutive pipe lines. A table has a header only when its second line is a separator. */
function markdownTables(body) {
  const tables = [];
  let current = [];
  for (const line of body.split('\n')) {
    if (isTableLine(line)) {
      current.push(line);
    } else if (current.length > 0) {
      tables.push(current);
      current = [];
    }
  }
  if (current.length > 0) {
    tables.push(current);
  }
  return tables;
}

function htmlRows(body) {
  const withoutHead = body.replace(/<thead[\s\S]*?<\/thead>/gi, '');
  return [...withoutHead.matchAll(/<tr\b[\s\S]*?<\/tr>/gi)].map(match => match[0]);
}

function htmlCells(row) {
  return [...row.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(match => match[1].replace(/<[^>]*>/g, ''));
}

/** The text that identifies a row: its first cell, or its second when the first is only a number. */
export function rowKeyOf(cells) {
  const first = cells[0];
  const pick = first !== undefined && RANK_CELL.test(first) ? cells[1] : first;
  if (pick === undefined) {
    return null;
  }
  const key = pick.replace(/[*_`]/g, '').trim().toLowerCase();
  return key === '' ? null : key;
}

/** Keys of the data rows, in order. Rows with no usable key still count as rows but have no key. */
function dataRows({ body, format }) {
  if (format === 'html') {
    return htmlRows(body).map(row => htmlCells(row));
  }
  const rows = [];
  for (const table of markdownTables(body)) {
    if (table.length >= 2 && isSeparatorLine(table[1])) {
      rows.push(...table.slice(2).map(cellsOf));
    }
  }
  return rows;
}

export function countRows({ body, format }) {
  return dataRows({ body, format }).length;
}

export function rowKeys({ body, format }) {
  return dataRows({ body, format })
    .map(rowKeyOf)
    .filter(key => key !== null);
}

export function countDuplicates({ body, format }) {
  const keys = rowKeys({ body, format });
  return keys.length - new Set(keys).size;
}

/**
 * Markdown: at least one table, and every table has a separator under its header and rows as wide as the header.
 * HTML: at least one table, and as many closing row tags as opening ones.
 */
export function isTableValid({ body, format }) {
  if (format === 'html') {
    const opened = (body.match(/<tr\b/gi) ?? []).length;
    const closed = (body.match(/<\/tr>/gi) ?? []).length;
    return /<table\b/i.test(body) && opened > 0 && opened === closed;
  }
  const tables = markdownTables(body);
  return (
    tables.length > 0 &&
    tables.every(
      table =>
        table.length >= 2 &&
        isSeparatorLine(table[1]) &&
        table.every(line => cellsOf(line).length === cellsOf(table[0]).length),
    )
  );
}

/** Lines that start with a list marker. A high count in an HTML page, or a flat dump of bullets, reads as unformatted. */
export function countRawListMarkers({ body }) {
  return body.split('\n').filter(line => /^\s*(?:[-*+]|\d+[.)])\s+\S/.test(line)).length;
}

/** Lines that are only bold text, which stand in for a real heading. */
export function countBoldLines({ body }) {
  return body.split('\n').filter(line => /^\s*(?:\*\*[^*]+\*\*|__[^_]+__):?\s*$/.test(line)).length;
}

/** Image links in the body: markdown images and HTML image tags. */
export function countPictures({ body }) {
  return (body.match(/!\[[^\]]*\]\([^)\s]+/g) ?? []).length + (body.match(/<img\b/gi) ?? []).length;
}

function collapse(text) {
  return text.replace(/\s+/g, ' ').trim();
}

/** True when the follow-up changed more than spacing. */
export function isFormattingChanged({ before, after }) {
  return collapse(before) !== collapse(after);
}

/** The reply names the space when it contains the space's name, ignoring case and markdown marks. */
export function replyNamesSpace({ reply, name }) {
  const plain = text => collapse(text.replace(/[*_`]/g, '')).toLowerCase();
  return reply.trim() !== '' && name.trim() !== '' && plain(reply).includes(plain(name));
}

/**
 * Walks revisions in order and reports the first row key that was in the revision before and is gone now.
 * Returns the empty string when no row was lost.
 * @param {{ revisions: ReadonlyArray<{ revision: number, body: string, format: string }> }} options
 */
export function findRowsLost({ revisions }) {
  let previous;
  for (const { revision, body, format } of revisions) {
    const keys = new Set(rowKeys({ body, format }));
    if (previous !== undefined) {
      const gone = [...previous].find(key => !keys.has(key));
      if (gone !== undefined) {
        return `revision ${String(revision)}: ${gone}`;
      }
    }
    previous = keys;
  }
  return '';
}

/**
 * Compares measured values with a prompt's targets. Returns the targets that were missed, as text.
 * @param {{ measures: Record<string, unknown>, expect: Record<string, number | boolean> }} options
 */
export function failedExpectations({ measures, expect }) {
  const failed = [];
  for (const [name, wanted] of Object.entries(expect)) {
    if (name === 'pictures_min') {
      if (typeof measures.pictures !== 'number' || measures.pictures < wanted) {
        failed.push(`pictures ${String(measures.pictures ?? 'unknown')} < ${String(wanted)}`);
      }
    } else if (measures[name] !== wanted) {
      failed.push(`${name} ${String(measures[name] ?? 'unknown')} != ${String(wanted)}`);
    }
  }
  return failed;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The tool's own result inside a stored tool response, unwrapping the versioned envelope. */
function resultPayload(content) {
  const parsed = parseJson(content);
  if (typeof parsed !== 'object' || parsed === null || !('schema_version' in parsed) || !('result' in parsed)) {
    return parsed;
  }
  return typeof parsed.result === 'string' ? (parseJson(parsed.result) ?? parsed.result) : parsed.result;
}

function responseText(event) {
  if (typeof event.content === 'string') {
    return event.content;
  }
  return Array.isArray(event.content)
    ? event.content.map(part => (typeof part?.text === 'string' ? part.text : '')).join('\n')
    : '';
}

/**
 * Ids of the spaces this chat's own successful create_space calls made, read from its stored events.
 * Only these may be scored or deleted: a space someone else made during the run is never named here.
 * @param {ReadonlyArray<{ event?: Record<string, unknown> }>} items
 */
export function createdSpaceIds(items) {
  const callNames = new Map();
  for (const { event } of items) {
    if (event?.type === 'model.message' && Array.isArray(event.tool_calls)) {
      for (const call of event.tool_calls) {
        if (typeof call?.id === 'string' && typeof call.tool_info?.name === 'string') {
          callNames.set(call.id, call.tool_info.name);
        }
      }
    }
  }
  const ids = new Set();
  for (const { event } of items) {
    const isV2 = event?.type === 'tool.response.v2';
    if (!(isV2 || event?.type === 'tool.response')) {
      continue;
    }
    if (isV2 && event.disposition !== 'executed_ok') {
      continue;
    }
    const name = callNames.get(event.tool_call_id);
    if (name === undefined || !/(^|[._-])create_space$/.test(name)) {
      continue;
    }
    const link = resultPayload(responseText(event))?.space?.link;
    const match = typeof link === 'string' ? /^\/spaces\/([^/?#]+)$/.exec(link) : null;
    if (match !== null) {
      ids.add(decodeURIComponent(match[1]));
    }
  }
  return ids;
}

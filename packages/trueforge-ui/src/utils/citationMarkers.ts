/**
 * Citation marker extraction, resolution, and rendering for model-emitted markers like
 * 【14†excerpts】 or 【14†L3-L9】.
 *
 * Two marker families are supported:
 * - Numeric markers (`【14†excerpts】`, or the JSON spelling `【{"id":14,"cursor":0}】` some
 *   models emit) refer to numbered sources from web search results. A numeric source keeps
 *   its established numbered-link rendering.
 * - Retrieval-ID markers (`【a3f9c21e†excerpts】`) refer to retrieval results by their chunk /
 *   retrieval ID. The chat's built-in extractor only produces numeric sources (the same
 *   message's `web_search` / `web_fetch` results, numbered 1..N as the model saw them); a
 *   string ID resolves only when the host supplies a matching source entry, in which case a
 *   resolved retrieval citation renders as a human-readable, clickable link showing the
 *   source title — never the raw ID.
 *
 * A marker whose ID cannot be resolved to a known source is removed from the rendered text;
 * raw IDs (hashes especially) must never leak into what the reader sees.
 *
 * Markers are preserved in code blocks and inline code spans per the markdown prose/code
 * distinction.
 */

import { parseMcpToolArgs } from './toolCallParsing.js';
import { scanMarkdownSegments } from './transformMarkdownSource.js';

export type CitationSource = {
  /** Numeric for web-search sources, string for retrieval (chunk) IDs. */
  id: number | string;
  title: string;
  url?: string;
};

/**
 * A citation marker extracted from markdown, with its position and source metadata.
 */
export type CitationMarker = {
  /** The ID from the marker: a number for 【14†…】, the raw retrieval ID string otherwise. */
  sourceId: number | string;
  /** The full marker text as it appears in the source (e.g., "【14†excerpts】"). */
  text: string;
  /** Start position in the source string. */
  start: number;
  /** End position in the source string. */
  end: number;
  /** Descriptor from the marker (e.g., "excerpts" or "L3-L9"); empty for the JSON spelling. */
  descriptor: string;
};

/**
 * Matches citation markers like 【14†excerpts】, 【14†L3-L9】, 【a3f9c21e†excerpts】, or the
 * JSON spelling 【{"id":14,"cursor":0,"loc":0}】. The marker contains:
 * - Opening bracket: 【 (U+3010)
 * - Either a JSON object body (`{…}` with no closing bracket inside), or
 *   an ID (digits, or an alphanumeric retrieval ID: letters, digits, `-`, `_`; at most 128
 *   chars), a dagger † (U+2020), and a descriptor of one or more non-bracket characters
 * - Closing bracket: 】 (U+3011)
 */
const CITATION_MARKER_RE = /【(?:(\{[^】]*\})|(\d+|[A-Za-z0-9][A-Za-z0-9_-]{0,127})†([^】]+))】/g;

/** Parses a marker ID: all-digit IDs become numbers, anything else stays a string. */
function parseMarkerId(raw: string): number | string {
  return /^\d+$/.test(raw) ? parseInt(raw, 10) : raw;
}

/**
 * Parses a JSON marker body to its numeric `id`; other keys (`cursor`, `loc`, …) are ignored.
 * Returns null when the body is not a JSON object with a non-negative integer `id`, so the
 * text is left alone like any other non-marker.
 */
function parseJsonMarkerId(body: string): number | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }
  const id = parsed['id'];
  return typeof id === 'number' && Number.isInteger(id) && id >= 0 ? id : null;
}

/**
 * Extracts all citation markers from markdown source, respecting code blocks and inline code.
 * Markers inside code are ignored.
 */
export function extractCitationMarkers(source: string): CitationMarker[] {
  const segments = scanMarkdownSegments(source);
  const markers: CitationMarker[] = [];

  // Process only non-code segments
  let positionOffset = 0;
  const regex = new RegExp(CITATION_MARKER_RE.source, 'g');
  for (const segment of segments) {
    if (!segment.inCode) {
      // Find all markers in this prose segment
      let match: RegExpExecArray | null;
      while ((match = regex.exec(segment.text)) !== null) {
        const full = match[0];
        const jsonBody = match[1];
        const rawId = match[2];
        let sourceId: number | string;
        let descriptor: string;
        if (jsonBody !== undefined) {
          const jsonId = parseJsonMarkerId(jsonBody);
          if (jsonId === null) {
            continue;
          }
          sourceId = jsonId;
          descriptor = '';
        } else if (rawId !== undefined && match[3] !== undefined) {
          sourceId = parseMarkerId(rawId);
          descriptor = match[3];
        } else {
          continue;
        }
        const start = positionOffset + match.index;
        const end = start + full.length;

        markers.push({
          sourceId,
          text: full,
          start,
          end,
          descriptor,
        });
      }
      // Reset lastIndex for the next segment
      regex.lastIndex = 0;
    }

    positionOffset += segment.text.length;
  }

  return markers;
}

/** The lookup key for a source ID: numeric IDs and their string spellings share one bucket. */
function sourceKey(id: number | string): string {
  return typeof id === 'number' ? `n:${String(id)}` : `s:${id}`;
}

/**
 * Builds the canonical ID→source index from retrieval results or search results. Keys are
 * normalized so a numeric marker matches a numeric source (and vice versa for string
 * spellings); the first source wins when two inputs share an ID.
 */
export function buildCitationSourceIndex(sources: Iterable<CitationSource>): Map<string, CitationSource> {
  const index = new Map<string, CitationSource>();
  for (const source of sources) {
    const key = sourceKey(source.id);
    if (!index.has(key)) {
      index.set(key, source);
    }
  }
  return index;
}

/**
 * Resolves a citation marker's ID to a source from a sources map or array.
 * Returns the source if found, or null if not found.
 */
export function resolveCitationSource(
  marker: CitationMarker,
  sources:
    | Map<number | string, CitationSource>
    | Map<string, CitationSource>
    | Map<number, CitationSource>
    | CitationSource[]
    | null
    | undefined,
): CitationSource | null {
  if (!sources) return null;

  if (sources instanceof Map) {
    // Normalize through the canonical index so a numeric marker matches a numeric source
    // regardless of the map's declared key type.
    return buildCitationSourceIndex(sources.values()).get(sourceKey(marker.sourceId)) ?? null;
  }

  // Array-based: match by id when sources carry explicit ids; otherwise use position
  // (1-indexed) for numeric markers, matching the numbered search-result convention.
  const hasExplicitIds = sources.some(s => s.id !== undefined);
  if (hasExplicitIds) {
    return sources.find(s => s.id !== undefined && sourceKey(s.id) === sourceKey(marker.sourceId)) ?? null;
  }
  if (typeof marker.sourceId === 'number') {
    return sources[marker.sourceId - 1] || null;
  }
  return null;
}

/**
 * Renders one citation marker to its markdown replacement.
 *
 * - Resolved numeric source with a URL: the established numbered link `[【N】](url "title")`.
 * - Resolved retrieval-ID source with a URL: a human-readable clickable link `[title](url)`.
 * - Resolved retrieval-ID source without a URL: the plain title `[title]`.
 * - Anything else (unresolved, or a numeric source without a URL): the marker is removed.
 *   Raw IDs — chunk hashes especially — are never rendered as visible text.
 */
export function renderCitationReplacement(marker: CitationMarker, source: CitationSource | null): string {
  if (source == null) {
    return '';
  }
  const isNumeric = typeof marker.sourceId === 'number';
  if (source.url) {
    return isNumeric
      ? `[【${String(marker.sourceId)}】](${source.url} "${source.title}")`
      : `[${source.title}](${source.url})`;
  }
  return isNumeric ? '' : `[${source.title}]`;
}

/** A tool call as the citation collector needs it: name, raw args, and the raw result. */
export type CitationToolCall = {
  toolName: string;
  argsText?: string;
  result?: unknown;
};

/** Tool names whose results carry citable `results[]` items with titles and URLs. */
const SEARCH_TOOL_NAMES = new Set(['web_search', 'web_fetch']);

/** Mirrors the server's `WEB_SEARCH_RENDER_MAX_RESULTS`: only the first page is numbered. */
const MAX_CITABLE_RESULTS = 10;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(item: Record<string, unknown>, key: string): string | undefined {
  const value = item[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * The effective tool name for a tool-call part: MCP-dispatched calls arrive as `call_tool`
 * with the real tool in the args, so resolve through `tool_name` the same way the chat's
 * tool-call cards do.
 */
function effectiveToolName(call: CitationToolCall): string {
  if (call.toolName === 'call_tool') {
    return parseMcpToolArgs(call.argsText).innerToolName ?? call.toolName;
  }
  return call.toolName;
}

/**
 * Extracts citable results from one tool result payload: the `tool.response.v2` envelope's
 * `result.results[]`, keeping only items with a URL. Numbering restarts at 1 per call,
 * mirroring how the server numbers each search rendering for the model.
 */
function citableResults(result: unknown): Array<{ title: string; url: string }> {
  let parsed: unknown = result;
  if (typeof result === 'string') {
    try {
      parsed = JSON.parse(result);
    } catch {
      return [];
    }
  }
  if (!isRecord(parsed) || parsed['schema_version'] !== 'tool.response.v2') {
    return [];
  }
  const envelopeResult = parsed['result'];
  if (!isRecord(envelopeResult) || !Array.isArray(envelopeResult['results'])) {
    return [];
  }
  const items: Array<{ title: string; url: string }> = [];
  for (const raw of envelopeResult['results']) {
    if (!isRecord(raw)) {
      continue;
    }
    const url = stringField(raw, 'url');
    if (url === undefined) {
      continue;
    }
    items.push({ title: stringField(raw, 'title') ?? url, url });
    if (items.length >= MAX_CITABLE_RESULTS) {
      break;
    }
  }
  return items;
}

/**
 * Collects citation sources from a message's tool-call parts. This is the ID→title mapping the
 * chat UI builds from data it already receives: the same message's `web_search` / `web_fetch`
 * results, numbered 1..N per call exactly as the model saw them. When several search calls
 * ran, the latest call wins for a given number.
 */
export function extractSearchCitationSources(calls: readonly CitationToolCall[]): CitationSource[] {
  const byNumber = new Map<number, CitationSource>();
  for (const call of calls) {
    if (!SEARCH_TOOL_NAMES.has(effectiveToolName(call).toLowerCase())) {
      continue;
    }
    if (call.result === undefined) {
      continue;
    }
    const items = citableResults(call.result);
    // Later calls overwrite earlier ones for the same number.
    items.forEach((item, index) => {
      byNumber.set(index + 1, { id: index + 1, title: item.title, url: item.url });
    });
  }
  return [...byNumber.entries()].sort((a, b) => a[0] - b[0]).map(([, source]) => source);
}

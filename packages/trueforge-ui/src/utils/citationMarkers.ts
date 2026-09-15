/**
 * Citation marker extraction and rendering for model-emitted markers like 【14†excerpts】 or 【14†L3-L9】.
 * Markers are preserved in code blocks and inline code spans per the markdown prose/code distinction.
 */

import { scanMarkdownSegments } from './transformMarkdownSource.js';

export type CitationSource = {
  id: number;
  title: string;
  url?: string;
};

/**
 * A citation marker extracted from markdown, with its position and source metadata.
 */
export type CitationMarker = {
  /** The numeric ID from the marker (e.g., "14" from 【14†excerpts】). */
  sourceId: number;
  /** The full marker text as it appears in the source (e.g., "【14†excerpts】"). */
  text: string;
  /** Start position in the source string. */
  start: number;
  /** End position in the source string. */
  end: number;
  /** Descriptor from the marker (e.g., "excerpts" or "L3-L9"). */
  descriptor: string;
};

/**
 * Matches citation markers like 【14†excerpts】 or 【14†L3-L9】.
 * The marker contains:
 * - Opening bracket: 【 (U+3010)
 * - Number: one or more digits
 * - Dagger: † (U+2020)
 * - Descriptor: one or more non-bracket characters
 * - Closing bracket: 】 (U+3011)
 */
const CITATION_MARKER_RE = /【(\d+)†([^】]+)】/g;

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
      let match;
      while ((match = regex.exec(segment.text)) !== null) {
        const sourceId = parseInt(match[1]!, 10);
        const descriptor = match[2]!;
        const start = positionOffset + match.index;
        const end = start + match[0]!.length;

        markers.push({
          sourceId,
          text: match[0]!,
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

/**
 * Resolves a citation marker's numeric ID to a source from a sources map.
 * Returns the source if found, or null if not found.
 */
export function resolveCitationSource(
  marker: CitationMarker,
  sources: Map<number, CitationSource> | CitationSource[] | null | undefined,
): CitationSource | null {
  if (!sources) return null;

  if (Array.isArray(sources)) {
    // Array-based: if sources have explicit ids, match by id; otherwise use position (1-indexed)
    const hasExplicitIds = sources.some(s => s.id !== undefined);
    if (hasExplicitIds) {
      return sources.find(s => s.id === marker.sourceId) || null;
    }
    // Fall back to position-based lookup when no ids are present
    return sources[marker.sourceId - 1] || null;
  }

  if (sources instanceof Map) {
    return sources.get(marker.sourceId) || null;
  }

  return null;
}

/**
 * Replacement function for remark/rehype plugins to render citation markers.
 * This is used with a remark plugin to transform markers in the AST before rendering.
 *
 * When sources are available, markers are replaced with HTML that the downstream
 * component can render as links.
 */
export function replaceCitationMarker(marker: CitationMarker, source: CitationSource | null): string {
  if (source && source.url) {
    // Render with data attributes for downstream link rendering
    // Using a sentinel format that a rehype plugin can transform into a proper link
    return `[【${marker.sourceId}】](${source.url} "${source.title}")`;
  }

  if (source) {
    // No URL available, render as plain text number
    return `[${marker.sourceId}]`;
  }

  // Source not resolved; render as plain text number
  return `[${marker.sourceId}]`;
}

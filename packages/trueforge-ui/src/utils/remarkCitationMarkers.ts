/**
 * Remark plugin to transform citation markers like 【14†excerpts】 or 【a3f9c21e†excerpts】
 * into markdown links.
 * The plugin respects code blocks and inline code, preserving markers within them unchanged.
 */

import type { Text } from 'mdast';
import { visit } from 'unist-util-visit';

import {
  extractCitationMarkers,
  renderCitationReplacement,
  resolveCitationSource,
  type CitationSource,
} from './citationMarkers.js';

/** Sources keyed by numeric or retrieval ID; arrays keep their documented lookup semantics. */
export type CitationSourcesInput =
  | Map<number | string, CitationSource>
  | Map<string, CitationSource>
  | Map<number, CitationSource>
  | CitationSource[]
  | null
  | undefined;

/**
 * Creates a remark plugin that transforms citation markers into markdown links.
 * A resolved numeric source becomes its numbered link; a resolved retrieval-ID source becomes
 * a human-readable link on the source title. A marker that cannot be resolved is removed
 * from the text — raw IDs never render. Markers inside code blocks and inline code spans are
 * preserved unchanged (this filtering is done by extractCitationMarkers via
 * scanMarkdownSegments).
 */
export function remarkCitationMarkers(citationSources?: CitationSourcesInput) {
  return (tree: any) => {
    // Walk the tree and replace citation markers in text nodes
    visit(tree, 'text', (node: Text) => {
      const markers = extractCitationMarkers(node.value);
      if (markers.length === 0) return;

      // Sort markers by position in reverse order so we can replace them without
      // invalidating positions
      markers.sort((a, b) => b.start - a.start);

      let text = node.value;
      for (const marker of markers) {
        const resolved = resolveCitationSource(marker, citationSources);
        const replacement = renderCitationReplacement(marker, resolved);

        // Replace the marker with the link, the title, or nothing when unresolvable
        text = text.slice(0, marker.start) + replacement + text.slice(marker.end);
      }

      // Update the node's value with the transformed text
      node.value = text;
    });
  };
}

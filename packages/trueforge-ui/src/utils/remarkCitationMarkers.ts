/**
 * Remark plugin to transform citation markers like 【14†excerpts】 into markdown links.
 * The plugin respects code blocks and inline code, preserving markers within them unchanged.
 */

import type { Text } from 'mdast';
import { visit } from 'unist-util-visit';

import { extractCitationMarkers, resolveCitationSource, type CitationSource } from './citationMarkers.js';

/**
 * Creates a remark plugin that transforms citation markers into markdown link text.
 * When a source with a URL is found, the marker becomes a markdown link.
 * When not found or source has no URL, the marker is removed from the text.
 * Markers inside code blocks and inline code spans are preserved unchanged
 * (this filtering is done by extractCitationMarkers via scanMarkdownSegments).
 */
export function remarkCitationMarkers(citationSources?: Map<number, CitationSource> | CitationSource[] | null) {
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

        let replacement: string;
        if (resolved?.url) {
          // Render as a markdown link when source is known and has URL
          replacement = `[【${marker.sourceId}】](${resolved.url} "${resolved.title}")`;
        } else {
          // Remove the marker entirely when unresolved or source has no URL
          replacement = '';
        }

        // Replace the marker with the link or remove it
        text = text.slice(0, marker.start) + replacement + text.slice(marker.end);
      }

      // Update the node's value with the transformed text
      node.value = text;
    });
  };
}

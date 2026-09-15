import type { Root } from 'mdast';
import { visit } from 'unist-util-visit';

import { normalizeProseTypography } from './normalizeProseTypography.js';

/**
 * Remark plugin that applies {@link normalizeProseTypography} to every prose text node in the
 * markdown tree, skipping `code` (fenced) and `inlineCode` nodes so intentional use of these
 * characters in code is preserved.
 */
export function remarkNormalizeProseTypography() {
  return (tree: Root) => {
    visit(tree, node => {
      if (node.type === 'code' || node.type === 'inlineCode') {
        return 'skip';
      }
      if (node.type === 'text' && typeof node.value === 'string') {
        node.value = normalizeProseTypography(node.value);
      }
      return undefined;
    });
  };
}

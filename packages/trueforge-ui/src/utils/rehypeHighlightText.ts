import type { Element, Root, Text } from 'hast';
import { SKIP, visit } from 'unist-util-visit';

/** Classes on each highlighted match: a soft background and a bold weight, both from the theme. */
const MATCH_CLASSES = ['rounded-sm', 'bg-secondary-bg', 'px-0.5', 'font-semibold', 'text-text-primary'];

/**
 * Wraps each case-insensitive match of `query` in rendered text with a `mark` element. Run it
 * after sanitize: the marks are built here, so they never pass through the sanitizer.
 */
export function rehypeHighlightText(options: { query: string }) {
  const needle = options.query.toLowerCase();

  return (tree: Root) => {
    if (needle === '') return;
    visit(tree, 'text', (node: Text, index, parent) => {
      if (parent === undefined || index === undefined) return;
      const value = node.value;
      const lower = value.toLowerCase();
      if (!lower.includes(needle)) return;

      const pieces: Array<Text | Element> = [];
      let cursor = 0;
      for (let found = lower.indexOf(needle); found !== -1; found = lower.indexOf(needle, cursor)) {
        if (found > cursor) pieces.push({ type: 'text', value: value.slice(cursor, found) });
        pieces.push({
          type: 'element',
          tagName: 'mark',
          properties: { className: MATCH_CLASSES },
          children: [{ type: 'text', value: value.slice(found, found + needle.length) }],
        });
        cursor = found + needle.length;
      }
      if (cursor < value.length) pieces.push({ type: 'text', value: value.slice(cursor) });

      parent.children.splice(index, 1, ...pieces);
      return [SKIP, index + pieces.length];
    });
  };
}

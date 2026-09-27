import { describe, expect, it } from 'vitest';

import type { CitationSource } from '@/utils/citationMarkers.js';
import { remarkCitationMarkers } from '@/utils/remarkCitationMarkers.js';

function textTree(value: string) {
  return { type: 'root', children: [{ type: 'paragraph', children: [{ type: 'text', value }] }] };
}

function renderedText(tree: ReturnType<typeof textTree>): string {
  const paragraph = tree.children[0];
  const text = paragraph?.children[0];
  if (text === undefined) {
    throw new Error('expected a text node in the rendered tree');
  }
  return text.value;
}

describe('remarkCitationMarkers', () => {
  it('replaces a retrieval-ID marker with a human-readable link on the source title', () => {
    const tree = textTree('See the docs【a3f9c21e†excerpts】for details.');
    const sources = new Map<string, CitationSource>([
      ['a3f9c21e', { id: 'a3f9c21e', title: 'Search result title', url: 'https://example.com/a' }],
    ]);
    remarkCitationMarkers(sources)(tree);
    expect(renderedText(tree)).toBe('See the docs[Search result title](https://example.com/a)for details.');
  });

  it('keeps the established numbered link for numeric sources', () => {
    const tree = textTree('Cite【2†source】.');
    const sources = new Map<number, CitationSource>([[2, { id: 2, title: 'Two', url: 'https://example.com/2' }]]);
    remarkCitationMarkers(sources)(tree);
    expect(renderedText(tree)).toBe('Cite[【2】](https://example.com/2 "Two").');
  });

  it('removes unresolved markers so raw IDs never render', () => {
    const tree = textTree('Missing【deadbeef†excerpts】here.');
    remarkCitationMarkers(new Map())(tree);
    const text = renderedText(tree);
    expect(text).toBe('Missinghere.');
    expect(text).not.toContain('deadbeef');
  });

  it('handles several markers in one text node', () => {
    const tree = textTree('A【1†x】and B【xyz9†y】.');
    const sources: CitationSource[] = [
      { id: 1, title: 'One', url: 'https://example.com/1' },
      { id: 'xyz9', title: 'Why', url: 'https://example.com/xyz9' },
    ];
    remarkCitationMarkers(sources)(tree);
    expect(renderedText(tree)).toBe('A[【1】](https://example.com/1 "One")and B[Why](https://example.com/xyz9).');
  });
});

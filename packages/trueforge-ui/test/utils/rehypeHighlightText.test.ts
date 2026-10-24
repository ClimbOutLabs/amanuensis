import type { Element, Root } from 'hast';
import { describe, expect, it } from 'vitest';

import { rehypeHighlightText } from '@/utils/rehypeHighlightText.js';

function paragraph(children: Element['children']): Root {
  return { type: 'root', children: [{ type: 'element', tagName: 'p', properties: {}, children }] };
}

function run(query: string, tree: Root): void {
  rehypeHighlightText({ query })(tree);
}

function marksIn(tree: Root): string[] {
  const paragraphNode = tree.children[0];
  if (paragraphNode?.type !== 'element') return [];
  return paragraphNode.children.flatMap(child =>
    child.type === 'element' && child.tagName === 'mark'
      ? child.children.map(text => (text.type === 'text' ? text.value : ''))
      : [],
  );
}

describe('rehypeHighlightText', () => {
  it('wraps every case-insensitive match in a mark element and keeps the surrounding text', () => {
    const tree = paragraph([{ type: 'text', value: 'Tea at tea time' }]);

    run('TEA', tree);

    expect(marksIn(tree)).toEqual(['Tea', 'tea']);
    expect(tree.children[0]).toMatchObject({
      children: [
        { type: 'element', tagName: 'mark' },
        { type: 'text', value: ' at ' },
        { type: 'element', tagName: 'mark' },
        { type: 'text', value: ' time' },
      ],
    });
  });

  it('leaves the text unchanged when there is no query', () => {
    const tree = paragraph([{ type: 'text', value: 'Nothing to mark' }]);

    run('', tree);

    expect(tree).toEqual(paragraph([{ type: 'text', value: 'Nothing to mark' }]));
  });

  it('leaves text without a match alone', () => {
    const tree = paragraph([{ type: 'text', value: 'Lisbon in spring' }]);

    run('tea', tree);

    expect(tree).toEqual(paragraph([{ type: 'text', value: 'Lisbon in spring' }]));
  });

  it('marks a match at the very start and very end of a text node', () => {
    const tree = paragraph([{ type: 'text', value: 'tea and tea' }]);

    run('tea', tree);

    expect(marksIn(tree)).toEqual(['tea', 'tea']);
    expect(tree.children[0]).toMatchObject({
      children: [
        { type: 'element', tagName: 'mark' },
        { type: 'text', value: ' and ' },
        { type: 'element', tagName: 'mark' },
      ],
    });
  });
});

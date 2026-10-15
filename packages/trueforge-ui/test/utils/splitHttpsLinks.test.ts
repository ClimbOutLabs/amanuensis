import { describe, expect, it } from 'vitest';

import { splitHttpsLinks } from '@/utils/splitHttpsLinks.js';

function links(text: string): string[] {
  return splitHttpsLinks(text).flatMap(segment => (segment.kind === 'link' ? [segment.href] : []));
}

describe('splitHttpsLinks', () => {
  it('returns plain text as one segment', () => {
    expect(splitHttpsLinks('Nothing to link here.')).toEqual([
      { kind: 'text', start: 0, text: 'Nothing to link here.' },
    ]);
  });

  it('returns no segments for empty text', () => {
    expect(splitHttpsLinks('')).toEqual([]);
  });

  it('links an https URL and keeps the surrounding words', () => {
    expect(splitHttpsLinks('Install from https://docs.docker.com/engine/install/ and restart.')).toEqual([
      { kind: 'text', start: 0, text: 'Install from ' },
      {
        kind: 'link',
        start: 13,
        text: 'https://docs.docker.com/engine/install/',
        href: 'https://docs.docker.com/engine/install/',
      },
      { kind: 'text', start: 52, text: ' and restart.' },
    ]);
  });

  it('gives back exactly the input when the segments are joined', () => {
    for (const text of [
      'a https://example.com/x, b https://example.org/y. (https://example.net/z)',
      'https://example.com',
      'ftp://example.com and http://example.com and https://',
      'no links',
    ]) {
      expect(
        splitHttpsLinks(text)
          .map(segment => segment.text)
          .join(''),
      ).toBe(text);
    }
  });

  it('leaves the punctuation that ends a sentence outside the link', () => {
    expect(links('See https://example.com/a.')).toEqual(['https://example.com/a']);
    expect(links('Try https://example.com/a, https://example.com/b; or https://example.com/c!')).toEqual([
      'https://example.com/a',
      'https://example.com/b',
      'https://example.com/c',
    ]);
  });

  it('leaves a closing bracket outside the link unless the URL balances it', () => {
    expect(links('(see https://example.com/a)')).toEqual(['https://example.com/a']);
    expect(links('https://en.wikipedia.org/wiki/Foo_(bar)')).toEqual(['https://en.wikipedia.org/wiki/Foo_(bar)']);
    expect(links('(https://en.wikipedia.org/wiki/Foo_(bar)).')).toEqual(['https://en.wikipedia.org/wiki/Foo_(bar)']);
  });

  it('keeps the written text of the link and normalizes only the href', () => {
    const [link] = splitHttpsLinks('HTTPS://EXAMPLE.COM/Path');
    expect(link).toEqual({
      kind: 'link',
      start: 0,
      text: 'HTTPS://EXAMPLE.COM/Path',
      href: 'https://example.com/Path',
    });
  });

  it('does not link other schemes', () => {
    expect(links('http://example.com/a')).toEqual([]);
    expect(links('javascript:alert(1)')).toEqual([]);
    expect(links('data:text/html,<b>x</b>')).toEqual([]);
    expect(links('ftp://example.com/a')).toEqual([]);
    expect(links('mailto:someone@example.com')).toEqual([]);
  });

  it('does not link a URL that embeds credentials', () => {
    expect(links('https://user:secret@example.com/a')).toEqual([]);
    expect(links('https://user@example.com/a')).toEqual([]);
  });

  it('does not link a URL the parser rejects', () => {
    expect(links('https://')).toEqual([]);
    expect(links('https://.')).toEqual([]);
    expect(links('https://[not-an-ip]/a')).toEqual([]);
  });
});

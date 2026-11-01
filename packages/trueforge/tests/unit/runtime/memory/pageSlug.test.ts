import { isPageSlug, pageSlug, UNTITLED_PAGE_SLUG } from '../../../../src/runtime/memory/pageSlug';

describe('pageSlug', () => {
  it('lowercases, folds accents and joins words with one dash', () => {
    expect(pageSlug('Wendy')).toBe('wendy');
    expect(pageSlug('Sam (plumber)')).toBe('sam-plumber');
    expect(pageSlug('José')).toBe('jose');
    expect(pageSlug('Jose')).toBe('jose');
    expect(pageSlug('Zoë  Smith')).toBe('zoe-smith');
    expect(pageSlug('Anne-Marie')).toBe('anne-marie');
    expect(pageSlug('Anne Marie')).toBe('anne-marie');
    expect(pageSlug('The Madrid thing!')).toBe('the-madrid-thing');
  });

  it('keeps letters outside Latin', () => {
    expect(pageSlug('東京')).toBe('東京');
    expect(pageSlug('Мама')).toBe('мама');
  });

  it('never yields an empty, dot, or slash stem', () => {
    expect(pageSlug('')).toBe(UNTITLED_PAGE_SLUG);
    expect(pageSlug('...')).toBe(UNTITLED_PAGE_SLUG);
    expect(pageSlug('../../etc')).toBe('etc');
    expect(pageSlug('a/b')).toBe('a-b');
  });

  it('cuts long titles without leaving a trailing dash', () => {
    const slug = pageSlug(`${'word '.repeat(20)}end`);
    expect(slug.length).toBeLessThanOrEqual(64);
    expect(slug.endsWith('-')).toBe(false);
  });

  it('recognises its own output and nothing else', () => {
    expect(isPageSlug('sam-plumber')).toBe(true);
    expect(isPageSlug('Sam')).toBe(false);
    expect(isPageSlug('a..b')).toBe(false);
    expect(isPageSlug('')).toBe(false);
  });
});

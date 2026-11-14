import fc from 'fast-check';

import { foldName, isPageSlug, pageSlug, UNTITLED_PAGE_SLUG } from '../../../../src/runtime/memory/pageSlug';

describe('pageSlug', () => {
  it('lowercases, folds accents and joins words with one dash', () => {
    expect(pageSlug('Nora')).toBe('nora');
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

  it('folds Greek accents and the final sigma, and Cyrillic ё, but keeps й and the other Cyrillic letters', () => {
    expect(pageSlug('Ελένη')).toBe(pageSlug('ΕΛΕΝΗ'));
    expect(pageSlug('Ελένη')).toBe(pageSlug('Ελενη'));
    expect(pageSlug('Γιώργος')).toBe(pageSlug('ΓΙΩΡΓΟΣ'));
    expect(pageSlug('Ϊάσων')).toBe(pageSlug('Ιασων'));
    expect(pageSlug('Фёдор')).toBe(pageSlug('Федор'));
    expect(pageSlug('Фёдор')).toBe('федор');
    expect(pageSlug('Йорик')).not.toBe(pageSlug('Иорик'));
    expect(pageSlug('Їжак')).not.toBe(pageSlug('Ижак'));
    expect(foldName('Ελένη')).toBe(foldName('ΕΛΕΝΗ'));
  });

  it('keeps the marks that are part of a letter outside Latin', () => {
    expect(pageSlug('김민수')).toBe('김민수');
    expect(pageSlug('ジョン')).toBe('ジョン');
    expect(pageSlug('ハル')).not.toBe(pageSlug('バル'));
    expect(pageSlug('สมชาย ใจดี')).toBe('สมชาย-ใจดี');
    expect(pageSlug('प्रिया शर्मा')).toBe('प्रिया-शर्मा');
    expect(pageSlug('민수')).not.toBe(pageSlug('민숙'));
  });

  it('accepts a decomposed Hangul or kana title as the same page as its composed form', () => {
    expect(pageSlug('김민수'.normalize('NFD'))).toBe('김민수');
    expect(pageSlug('ジョン'.normalize('NFD'))).toBe('ジョン');
    expect(pageSlug('José'.normalize('NFD'))).toBe('jose');
  });

  it('recognises slugs for titles in every script as page names', () => {
    for (const title of ['김민수', 'ジョン', 'สมชาย', 'प्रिया', '東京', 'Мама', 'José']) {
      expect(isPageSlug(pageSlug(title))).toBe(true);
    }
  });

  it('cuts at whole letters and keeps the file name short enough for a file system', () => {
    const emoji = pageSlug('😀'.repeat(100));
    expect(Buffer.byteLength(`${emoji}.md`, 'utf8')).toBeLessThanOrEqual(255);
    const thai = pageSlug('สวัสดี'.repeat(30));
    expect(Buffer.byteLength(`${thai}.md`, 'utf8')).toBeLessThanOrEqual(255);
    expect(isPageSlug(thai)).toBe(true);
  });

  it('gives any title a slug that is a safe file stem and folds to itself', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), title => {
        const slug = pageSlug(title);
        expect(slug).not.toMatch(/[/\\.\0]/);
        expect(slug).not.toMatch(/^-|-$/);
        expect(pageSlug(slug)).toBe(slug);
        expect(isPageSlug(slug)).toBe(true);
        expect(slug.isWellFormed()).toBe(true);
        expect(Buffer.byteLength(`${slug}.md`, 'utf8')).toBeLessThanOrEqual(255);
      }),
      { numRuns: 500 },
    );
  });

  it('folds to a fixed point', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), text => {
        expect(foldName(foldName(text))).toBe(foldName(text));
      }),
      { numRuns: 500 },
    );
  });
});

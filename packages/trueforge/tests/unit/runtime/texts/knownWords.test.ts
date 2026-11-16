import {
  customWordProblem,
  foldWord,
  isAllowedWord,
  isEndingOrNumber,
  knownWords,
  NEVER_ENDINGS,
  NUMBER_WORDS,
  SPOKEN_DOT,
} from '../../../../src/runtime/texts/knownWords';

describe('the words a Full text may carry', () => {
  it('holds about 45,000 common English words, each of plain lower-case letters', () => {
    const words = knownWords();
    expect(words.size).toBeGreaterThan(40_000);
    expect(words.size).toBeLessThan(60_000);
    for (const word of words) {
      expect(word).toMatch(/^[a-z]+$/);
    }
    for (const word of ['call', 'dentist', 'insurance', 'card', 'bring', 'the', 'at', 'monday', 'march', 'dr']) {
      expect([word, words.has(word)]).toEqual([word, true]);
    }
  });

  it('holds no word that was taken off on purpose: no common web ending, spoken dot or number word', () => {
    const words = knownWords();
    for (const word of [...NEVER_ENDINGS, ...SPOKEN_DOT, ...NUMBER_WORDS]) {
      expect([word, words.has(word)]).toEqual([word, false]);
    }
    for (const word of [
      'com',
      'net',
      'org',
      'io',
      'co',
      'ly',
      'us',
      'uk',
      'me',
      'app',
      'dev',
      'info',
      'xyz',
      'zero',
      'one',
      'two',
      'five',
      'ten',
      'twenty',
      'ninety',
      'hundred',
      'thousand',
      'million',
      'oh',
      'double',
      'triple',
      'dot',
      'point',
      'period',
    ]) {
      expect([word, words.has(word)]).toEqual([word, false]);
    }
  });

  it('keeps everyday words that are also web endings but are not on the named list', () => {
    const words = knownWords();
    for (const word of [
      'dad',
      'email',
      'ms',
      'soccer',
      'grocery',
      'dental',
      'flights',
      'hotels',
      'yoga',
      'visa',
      'spa',
      'salon',
      'ski',
      'bike',
      'coupon',
      'rentals',
      'shop',
      'help',
      'today',
    ]) {
      expect([word, words.has(word)]).toEqual([word, true]);
    }
  });

  it('holds no single letter but a and i', () => {
    expect([...knownWords()].filter(word => word.length === 1).sort()).toEqual(['a', 'i']);
  });

  it('is built once and handed out as the same set', () => {
    expect(knownWords()).toBe(knownWords());
  });

  it('reads a word on the list, or one the person added, after folding case and accents', () => {
    expect(isAllowedWord({ word: foldWord('CAFÉ') })).toBe(true);
    expect(isAllowedWord({ word: 'zxqvj' })).toBe(false);
    expect(isAllowedWord({ word: 'zxqvj', extra: new Set(['zxqvj']) })).toBe(true);
  });
});

describe('a word the person adds to the words Aman may text', () => {
  it('takes a name of letters, folded to lower case without accents', () => {
    expect(customWordProblem('Patel')).toBeUndefined();
    expect(customWordProblem('Zoë')).toBeUndefined();
  });

  it('refuses digits, signs, spaces and a length outside 2 to 24 letters', () => {
    for (const word of ['', 'a', 'a1', 'two words', 'evil.com', "o'neil", 'x'.repeat(25), 'a-b']) {
      expect([word, customWordProblem(word)]).toEqual([word, expect.any(String)]);
    }
  });

  it('takes an everyday word that is also a web ending, such as dad or yoga', () => {
    for (const word of ['dad', 'Email', 'yoga', 'visa', 'juniper', 'ms']) {
      expect([word, customWordProblem(word)]).toEqual([word, undefined]);
    }
  });

  it('refuses the named web endings, the spoken dots and every number word', () => {
    for (const word of [
      'com',
      'COM',
      'io',
      'ly',
      'dev',
      'xyz',
      'five',
      'Twenty',
      'hundred',
      'dot',
      'point',
      'period',
    ]) {
      expect([word, customWordProblem(word)]).toEqual([word, expect.any(String)]);
      expect(isEndingOrNumber(word)).toBe(true);
    }
  });
});

import {
  containsHiddenCharacters,
  hasHiddenCharacters,
  isHiddenCodePoint,
} from '../../../src/core/permissions/hiddenCharacters';

const HIDDEN = [
  0x0000, 0x007f, 0x0085, 0x00ad, 0x034f, 0x061c, 0x115f, 0x1160, 0x180e, 0x200b, 0x200d, 0x2028, 0x2029, 0x202e,
  0x2060, 0x2800, 0x3164, 0xfe00, 0xfe0f, 0xfeff, 0xffa0, 0xfff9, 0xfffa, 0xfffb, 0xe000, 0xd800, 0x1d173, 0x1d17a,
  0xe0001, 0xe0020, 0xe007f, 0xe0100, 0xe01ef,
];

describe('hidden characters', () => {
  test.each(HIDDEN)('code point %i is hidden', codePoint => {
    expect(isHiddenCodePoint(codePoint)).toBe(true);
  });

  test.each([0x20, 0x41, 0xe9, 0x4f60, 0x1f600, 0xa0])('code point %i is shown', codePoint => {
    expect(isHiddenCodePoint(codePoint)).toBe(false);
  });

  test('tab, newline and carriage return lay text out and are not hidden in a message', () => {
    expect(hasHiddenCharacters('a\tb\r\nc\n')).toBe(false);
    expect(hasHiddenCharacters('a\u0000b')).toBe(true);
    expect(hasHiddenCharacters('a​b')).toBe(true);
  });

  test('searches keys and nested values', () => {
    expect(containsHiddenCharacters({ a: [{ b: 'ok' }], c: 3, d: null })).toBe(false);
    expect(containsHiddenCharacters({ a: [{ b: 'x\u{E0041}' }] })).toBe(true);
    expect(containsHiddenCharacters({ 'k​': 'ok' })).toBe(true);
  });
});

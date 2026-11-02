import { safeReturnTo } from '../../../src/auth/safeReturnTo';

describe('safeReturnTo', () => {
  it('returns same-origin relative paths unchanged', () => {
    expect(safeReturnTo('/')).toBe('/');
    expect(safeReturnTo('/settings')).toBe('/settings');
    expect(safeReturnTo('/settings?tab=mcp&pUid=abc')).toBe('/settings?tab=mcp&pUid=abc');
    expect(safeReturnTo('/chat')).toBe('/chat');
  });

  it('falls back to the public UI home for missing or unsafe values', () => {
    expect(safeReturnTo('https://evil.example.com/')).toBe('/');
    expect(safeReturnTo('//evil.example.com/')).toBe('/');
    expect(safeReturnTo('/api')).toBe('/');
    expect(safeReturnTo('/api/v1/auth/login')).toBe('/');
    expect(safeReturnTo('relative')).toBe('/');
    expect(safeReturnTo(undefined)).toBe('/');
  });

  it.each([
    ['backslash after the slash', '/\\evil.example'],
    ['leading backslash', '\\evil.example'],
    ['raw carriage return', '/\r/evil.example'],
    ['raw newline', '/\n/evil.example'],
    ['slash then tab then slash', '/\t/evil.example'],
    ['encoded tab between slashes', '/%09/evil.example'],
    ['encoded newline', '/%0a/evil.example'],
    ['encoded carriage return', '/%0D/evil.example'],
    ['encoded backslash', '/%5Cevil.example'],
    ['encoded backslash lowercase', '/%5cevil.example'],
    ['double slash', '//evil.example'],
    ['slash backslash', '/\\/evil.example'],
    ['backslash deeper in the path', '/ok\\evil.example'],
    ['control character in the query', '/ok?x=\u0001'],
    ['delete character', '/ok\u007f'],
    ['null byte', '/ok\u0000'],
    ['scheme with host', 'https://evil.example'],
    ['scheme without slashes', 'https:evil.example'],
    ['javascript scheme', 'javascript:alert(1)'],
    ['leading space', ' /ok'],
    ['empty', ''],
  ])('falls back to the UI home for %s', (_label, value) => {
    expect(safeReturnTo(value)).toBe('/');
  });

  it('keeps ordinary encoded characters and query strings', () => {
    expect(safeReturnTo('/chat/a%20b?next=%2Fsettings')).toBe('/chat/a%20b?next=%2Fsettings');
    expect(safeReturnTo('/sessions/abc#top')).toBe('/sessions/abc#top');
  });
});

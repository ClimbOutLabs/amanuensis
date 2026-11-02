import { parseBrowserSecret, parseBrowserUrl } from '../../../src/config';

describe('parseBrowserUrl', () => {
  it('leaves the browser off when unset or blank', () => {
    expect(parseBrowserUrl(undefined)).toBeUndefined();
    expect(parseBrowserUrl('  ')).toBeUndefined();
  });

  it('accepts the gateway address, trimmed', () => {
    expect(parseBrowserUrl(' http://browser-relay:8792 ')).toBe('http://browser-relay:8792');
  });

  it('refuses anything that is not an http address', () => {
    expect(() => parseBrowserUrl('browser-relay:8792')).toThrow(/BROWSER_URL must be an http\(s\) URL/);
    expect(() => parseBrowserUrl('file:///run/browser.sock')).toThrow(/BROWSER_URL/);
  });
});

describe('parseBrowserSecret', () => {
  it('has no secret when unset or blank', () => {
    expect(parseBrowserSecret(undefined)).toBeUndefined();
    expect(parseBrowserSecret('')).toBeUndefined();
  });

  it('accepts a secret of 32 or more characters, trimmed', () => {
    const secret = 'a'.repeat(32);
    expect(parseBrowserSecret(` ${secret}\n`)).toBe(secret);
  });

  it('refuses a short secret and says what to do', () => {
    expect(() => parseBrowserSecret('a'.repeat(31))).toThrow(/at least 32 characters/);
  });
});

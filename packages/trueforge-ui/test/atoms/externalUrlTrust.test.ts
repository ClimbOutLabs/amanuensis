// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  EXTERNAL_URL_TRUST_STORAGE_KEY,
  REMEMBERED_IMAGE_URL_LIMIT,
  clearSessionImageTrust,
  getOrigin,
  getSessionImageTrustVersion,
  isExternalHttpUrl,
  isSessionImageUrlTrusted,
  isTrustedImageUrl,
  isTrustedLinkOrigin,
  trustImageUrl,
  trustLinkOrigin,
  trustSessionImageUrl,
} from '@/atoms/externalUrlTrust.js';

// The storage key name before the rename; stores under it must move over.
const LEGACY_EXTERNAL_URL_TRUST_STORAGE_KEY = 'aui-trusted-external-hosts';

afterEach(() => {
  window.localStorage.removeItem(EXTERNAL_URL_TRUST_STORAGE_KEY);
  window.localStorage.removeItem(LEGACY_EXTERNAL_URL_TRUST_STORAGE_KEY);
  clearSessionImageTrust();
  vi.restoreAllMocks();
});

describe('getOrigin', () => {
  it('returns the scheme, host and port for http(s) URLs', () => {
    expect(getOrigin('https://Example.COM/path')).toBe('https://example.com');
    expect(getOrigin('http://evil.test:8080/?q=1')).toBe('http://evil.test:8080');
    expect(getOrigin('https://example.com/docs')).not.toBe(getOrigin('http://example.com:8080/docs'));
  });

  it('resolves protocol-relative URLs against the page', () => {
    const expected = new URL('//CDN.Example.com:8443/a.png', window.location.href).origin;
    expect(getOrigin('//CDN.Example.com:8443/a.png')).toBe(expected);
  });

  it('returns null for non-http(s) schemes', () => {
    expect(getOrigin('javascript:alert(1)')).toBeNull();
    expect(getOrigin('data:image/png;base64,abc')).toBeNull();
  });

  it('returns the page origin for same-document relative paths', () => {
    expect(getOrigin('/relative/path')).toBe(window.location.origin);
  });
});

describe('isExternalHttpUrl', () => {
  it('is true for absolute http(s) on another host', () => {
    expect(isExternalHttpUrl('https://example.com/x')).toBe(true);
  });

  it('is true for protocol-relative URLs on another host', () => {
    expect(isExternalHttpUrl('//attacker.example/track')).toBe(true);
  });

  it('is false for same-origin, relative, data, and blob URLs', () => {
    const sameOrigin = `${window.location.origin}/local.png`;
    expect(isExternalHttpUrl(sameOrigin)).toBe(false);
    expect(isExternalHttpUrl('/relative.png')).toBe(false);
    expect(isExternalHttpUrl('data:image/png;base64,abc')).toBe(false);
    expect(isExternalHttpUrl('blob:https://example.com/uuid')).toBe(false);
  });

  it('is true for the same host on a different port', () => {
    const origin = new URL(window.location.origin);
    const otherPort = origin.port === '9000' ? '9001' : '9000';
    expect(isExternalHttpUrl(`${origin.protocol}//${origin.hostname}:${otherPort}/x`)).toBe(true);
  });

  it('is true for localhost on a different port than the page', () => {
    // Pin the reported case directly: the page host is localhost in jsdom, so
    // only the port differs. Hostname-only checks wrongly called this internal.
    if (window.location.hostname.toLowerCase() === 'localhost') {
      const pagePort = window.location.port === '9000' ? '9001' : '9000';
      expect(isExternalHttpUrl(`http://localhost:${pagePort}/x`)).toBe(true);
    }
  });

  it('is true for the same host with a different scheme', () => {
    const origin = new URL(window.location.origin);
    const otherProtocol = origin.protocol === 'https:' ? 'http:' : 'https:';
    const portPart = origin.port === '' ? '' : `:${origin.port}`;
    expect(isExternalHttpUrl(`${otherProtocol}//${origin.hostname}${portPart}/x`)).toBe(true);
  });
});

describe('trustLinkOrigin / isTrustedLinkOrigin', () => {
  it('persists remembered link origins', () => {
    trustLinkOrigin('https://React.DEV/some/page');
    expect(isTrustedLinkOrigin('https://react.dev')).toBe(true);
    expect(isTrustedLinkOrigin('https://react.dev/another/page')).toBe(true);
    expect(isTrustedLinkOrigin('https://other.dev')).toBe(false);

    const storedRaw = window.localStorage.getItem(EXTERNAL_URL_TRUST_STORAGE_KEY);
    expect(storedRaw).toContain('"version":2');
    expect(storedRaw).toContain('"https://react.dev"');
  });

  it('does not cover another scheme or port on the same host', () => {
    trustLinkOrigin('https://example.com');
    expect(isTrustedLinkOrigin('https://example.com')).toBe(true);
    expect(isTrustedLinkOrigin('http://example.com')).toBe(false);
    expect(isTrustedLinkOrigin('http://example.com:8080')).toBe(false);
    expect(isTrustedLinkOrigin('https://example.com:8443')).toBe(false);
  });

  it('does not let a remembered link origin trust an image', () => {
    trustLinkOrigin('https://cdn.example.com');
    expect(isTrustedImageUrl('https://cdn.example.com/a.png')).toBe(false);
  });
});

describe('trustImageUrl / isTrustedImageUrl', () => {
  it('remembers only the exact image address, not the whole host', () => {
    trustImageUrl('https://cdn.example.com/a.png');
    expect(isTrustedImageUrl('https://cdn.example.com/a.png')).toBe(true);
    expect(isTrustedImageUrl('https://cdn.example.com/b.png')).toBe(false);
    expect(isTrustedImageUrl('https://cdn.example.com/a.png?other=1')).toBe(false);
    expect(isTrustedLinkOrigin('https://cdn.example.com')).toBe(false);
  });

  it('keeps only the most recent remembered images up to the limit', () => {
    for (let index = 0; index <= REMEMBERED_IMAGE_URL_LIMIT; index += 1) {
      trustImageUrl(`https://cap.example/image-${String(index).padStart(3, '0')}.png`);
    }
    expect(isTrustedImageUrl('https://cap.example/image-000.png')).toBe(false);
    expect(isTrustedImageUrl('https://cap.example/image-001.png')).toBe(true);
    const newest = `https://cap.example/image-${String(REMEMBERED_IMAGE_URL_LIMIT).padStart(3, '0')}.png`;
    expect(isTrustedImageUrl(newest)).toBe(true);

    const storedRaw = window.localStorage.getItem(EXTERNAL_URL_TRUST_STORAGE_KEY);
    expect(storedRaw).not.toContain('"https://cap.example/image-000.png"');
    expect(storedRaw).toContain(`"${newest}"`);
  });

  it('trims an over-limit stored image list to the most recent entries when read', () => {
    const images: string[] = [];
    for (let index = 0; index < REMEMBERED_IMAGE_URL_LIMIT + 5; index += 1) {
      images.push(`https://stored-cap.example/image-${String(index).padStart(3, '0')}.png`);
    }
    window.localStorage.setItem(EXTERNAL_URL_TRUST_STORAGE_KEY, JSON.stringify({ version: 2, links: [], images }));
    expect(isTrustedImageUrl('https://stored-cap.example/image-000.png')).toBe(false);
    expect(isTrustedImageUrl('https://stored-cap.example/image-004.png')).toBe(false);
    expect(isTrustedImageUrl('https://stored-cap.example/image-005.png')).toBe(true);
    const newest = images[images.length - 1];
    expect(newest).toBeDefined();
    if (newest != null) expect(isTrustedImageUrl(newest)).toBe(true);
  });

  it('does not trust an image or a link from a version 1 host entry', () => {
    window.localStorage.setItem(
      EXTERNAL_URL_TRUST_STORAGE_KEY,
      JSON.stringify({ version: 1, links: ['kept.example'], images: ['evil.example'] }),
    );
    expect(isTrustedImageUrl('https://evil.example/p.png')).toBe(false);
    // A version 1 link entry names only a host, with no scheme or port, so it
    // cannot become the one origin the person saw and drops in the upgrade.
    expect(isTrustedLinkOrigin('https://kept.example')).toBe(false);
  });
});

describe('storage key rename', () => {
  it('uses the urls key name, not the old hosts name', () => {
    expect(EXTERNAL_URL_TRUST_STORAGE_KEY).toBe('aui-trusted-external-urls');
  });

  it('moves a store under the old key to the new key when it is read', () => {
    window.localStorage.setItem(
      LEGACY_EXTERNAL_URL_TRUST_STORAGE_KEY,
      JSON.stringify({
        version: 2,
        links: ['https://moved.example'],
        images: ['https://img.example/moved.png'],
      }),
    );
    expect(isTrustedLinkOrigin('https://moved.example')).toBe(true);
    expect(isTrustedImageUrl('https://img.example/moved.png')).toBe(true);
    expect(window.localStorage.getItem(LEGACY_EXTERNAL_URL_TRUST_STORAGE_KEY)).toBeNull();
    const movedRaw = window.localStorage.getItem(EXTERNAL_URL_TRUST_STORAGE_KEY);
    expect(movedRaw).toContain('"version":2');
    expect(movedRaw).toContain('"https://moved.example"');
    expect(movedRaw).toContain('"https://img.example/moved.png"');
  });

  it('upgrades a version 1 store under the old key as it moves', () => {
    window.localStorage.setItem(
      LEGACY_EXTERNAL_URL_TRUST_STORAGE_KEY,
      JSON.stringify({ version: 1, links: ['old.example'], images: ['old.example'] }),
    );
    expect(isTrustedImageUrl('https://old.example/p.png')).toBe(false);
    expect(window.localStorage.getItem(LEGACY_EXTERNAL_URL_TRUST_STORAGE_KEY)).toBeNull();
    expect(window.localStorage.getItem(EXTERNAL_URL_TRUST_STORAGE_KEY)).toBe(
      JSON.stringify({ version: 2, links: [], images: [] }),
    );
  });
});

describe('session image trust', () => {
  it('trusts only the exact image address for the session', () => {
    trustSessionImageUrl('https://cdn.example.com/a.png');
    expect(isSessionImageUrlTrusted('https://cdn.example.com/a.png')).toBe(true);
    expect(isSessionImageUrlTrusted('https://cdn.example.com/b.png')).toBe(false);
    // Session trust never writes the remembered store.
    expect(isTrustedImageUrl('https://cdn.example.com/a.png')).toBe(false);
    expect(window.localStorage.getItem(EXTERNAL_URL_TRUST_STORAGE_KEY)).toBeNull();
  });

  it('answers as of the session trust version passed in', () => {
    const versionBefore = getSessionImageTrustVersion();
    trustSessionImageUrl('https://cdn.example.com/versioned.png');
    expect(isSessionImageUrlTrusted('https://cdn.example.com/versioned.png', versionBefore)).toBe(false);
    expect(isSessionImageUrlTrusted('https://cdn.example.com/versioned.png', getSessionImageTrustVersion())).toBe(true);
    expect(isSessionImageUrlTrusted('https://cdn.example.com/versioned.png')).toBe(true);
  });
});

describe('stored trust parsing', () => {
  it('parses the stored value once until it changes', () => {
    window.localStorage.setItem(
      EXTERNAL_URL_TRUST_STORAGE_KEY,
      JSON.stringify({
        version: 2,
        links: ['https://parse-once.example'],
        images: ['https://img.example/parse-once.png'],
      }),
    );
    const parseSpy = vi.spyOn(JSON, 'parse');
    expect(isTrustedLinkOrigin('https://parse-once.example')).toBe(true);
    expect(isTrustedImageUrl('https://img.example/parse-once.png')).toBe(true);
    expect(isTrustedLinkOrigin('https://parse-once.example')).toBe(true);
    expect(parseSpy).toHaveBeenCalledTimes(1);
  });
});

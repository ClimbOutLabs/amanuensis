// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  EXTERNAL_URL_TRUST_STORAGE_KEY,
  clearSessionImageTrust,
  getHostname,
  isExternalHttpUrl,
  isSessionImageUrlTrusted,
  isTrustedImageUrl,
  isTrustedLinkHost,
  trustImageUrl,
  trustLinkHost,
  trustSessionImageUrl,
} from '@/atoms/externalUrlTrust.js';

afterEach(() => {
  window.localStorage.removeItem(EXTERNAL_URL_TRUST_STORAGE_KEY);
  clearSessionImageTrust();
  vi.restoreAllMocks();
});

describe('getHostname', () => {
  it('returns lowercase host for http(s) URLs', () => {
    expect(getHostname('https://Example.COM/path')).toBe('example.com');
    expect(getHostname('http://evil.test/?q=1')).toBe('evil.test');
  });

  it('resolves protocol-relative URLs against the page', () => {
    expect(getHostname('//CDN.Example.com/a.png')).toBe('cdn.example.com');
  });

  it('returns null for non-http(s) schemes', () => {
    expect(getHostname('javascript:alert(1)')).toBeNull();
    expect(getHostname('data:image/png;base64,abc')).toBeNull();
  });

  it('returns the page host for same-document relative paths', () => {
    expect(getHostname('/relative/path')).toBe(window.location.hostname.toLowerCase());
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

describe('trustLinkHost / isTrustedLinkHost', () => {
  it('persists remembered link hosts', () => {
    trustLinkHost('React.DEV');
    expect(isTrustedLinkHost('react.dev')).toBe(true);
    expect(isTrustedLinkHost('other.dev')).toBe(false);

    const storedRaw = window.localStorage.getItem(EXTERNAL_URL_TRUST_STORAGE_KEY);
    expect(storedRaw).toContain('"version":2');
    expect(storedRaw).toContain('"react.dev"');
  });

  it('does not let a remembered link host trust an image', () => {
    trustLinkHost('cdn.example.com');
    expect(isTrustedImageUrl('https://cdn.example.com/a.png')).toBe(false);
  });
});

describe('trustImageUrl / isTrustedImageUrl', () => {
  it('remembers only the exact image address, not the whole host', () => {
    trustImageUrl('https://cdn.example.com/a.png');
    expect(isTrustedImageUrl('https://cdn.example.com/a.png')).toBe(true);
    expect(isTrustedImageUrl('https://cdn.example.com/b.png')).toBe(false);
    expect(isTrustedImageUrl('https://cdn.example.com/a.png?other=1')).toBe(false);
    expect(isTrustedLinkHost('cdn.example.com')).toBe(false);
  });

  it('does not trust an image from a version 1 host entry', () => {
    window.localStorage.setItem(
      EXTERNAL_URL_TRUST_STORAGE_KEY,
      JSON.stringify({ version: 1, links: ['kept.example'], images: ['evil.example'] }),
    );
    expect(isTrustedImageUrl('https://evil.example/p.png')).toBe(false);
    // Link hosts from the old store still count; only host-wide image entries drop.
    expect(isTrustedLinkHost('kept.example')).toBe(true);
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
});

describe('stored trust parsing', () => {
  it('parses the stored value once until it changes', () => {
    window.localStorage.setItem(
      EXTERNAL_URL_TRUST_STORAGE_KEY,
      JSON.stringify({ version: 2, links: ['parse-once.example'], images: ['https://img.example/parse-once.png'] }),
    );
    const parseSpy = vi.spyOn(JSON, 'parse');
    expect(isTrustedLinkHost('parse-once.example')).toBe(true);
    expect(isTrustedImageUrl('https://img.example/parse-once.png')).toBe(true);
    expect(isTrustedLinkHost('parse-once.example')).toBe(true);
    expect(parseSpy).toHaveBeenCalledTimes(1);
  });
});

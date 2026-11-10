import { describe, expect, it } from 'vitest';

import { CATALOG_LOGOS } from '@/icons/catalogLogos.js';
import {
  bundledCatalogLogo,
  catalogLogoSrc,
  resolveCatalogLogoSrc,
  toDarkCatalogLogoUrl,
  toLightCatalogLogoUrl,
  toSameOriginCatalogLogoUrl,
} from '@/utils/catalogLogo.js';

describe('toDarkCatalogLogoUrl', () => {
  it('inserts -dark before the file extension', () => {
    expect(toDarkCatalogLogoUrl('https://assets.example/icon.png')).toBe('https://assets.example/icon-dark.png');
    expect(toDarkCatalogLogoUrl('https://assets.example/openai.svg')).toBe('https://assets.example/openai-dark.svg');
  });

  it('preserves query and hash suffixes', () => {
    expect(toDarkCatalogLogoUrl('https://assets.example/icon.png?v=2#mark')).toBe(
      'https://assets.example/icon-dark.png?v=2#mark',
    );
  });

  it('returns undefined when the URL is already dark-suffixed', () => {
    expect(toDarkCatalogLogoUrl('https://assets.example/icon-dark.png')).toBeUndefined();
    expect(toDarkCatalogLogoUrl('https://assets.example/Sentry-Dark.svg')).toBeUndefined();
  });

  it('returns undefined for paths without a file extension', () => {
    expect(toDarkCatalogLogoUrl('https://assets.example/icon')).toBeUndefined();
  });
});

describe('toLightCatalogLogoUrl', () => {
  it('strips -dark before the file extension', () => {
    expect(toLightCatalogLogoUrl('https://assets.example/icon-dark.png')).toBe('https://assets.example/icon.png');
    expect(toLightCatalogLogoUrl('https://assets.example/github-dark.svg')).toBe('https://assets.example/github.svg');
  });

  it('preserves query and hash suffixes', () => {
    expect(toLightCatalogLogoUrl('https://assets.example/icon-dark.png?v=2#mark')).toBe(
      'https://assets.example/icon.png?v=2#mark',
    );
  });

  it('returns undefined when the URL is not dark-suffixed', () => {
    expect(toLightCatalogLogoUrl('https://assets.example/icon.png')).toBeUndefined();
    expect(toLightCatalogLogoUrl('https://assets.example/icon-darkmode.png')).toBeUndefined();
  });
});

describe('resolveCatalogLogoSrc', () => {
  it('keeps a light catalog URL in light mode', () => {
    expect(resolveCatalogLogoSrc({ src: 'https://assets.example/icon.png', mode: 'light' })).toBe(
      'https://assets.example/icon.png',
    );
  });

  it('strips -dark in light mode when the catalog URL is dark-suffixed', () => {
    expect(resolveCatalogLogoSrc({ src: 'https://assets.example/github-dark.svg', mode: 'light' })).toBe(
      'https://assets.example/github.svg',
    );
  });

  it('prefers the dark sibling in dark mode', () => {
    expect(resolveCatalogLogoSrc({ src: 'https://assets.example/icon.png', mode: 'dark' })).toBe(
      'https://assets.example/icon-dark.png',
    );
  });

  it('keeps a dark-suffixed catalog URL in dark mode', () => {
    expect(resolveCatalogLogoSrc({ src: 'https://assets.example/icon-dark.png', mode: 'dark' })).toBe(
      'https://assets.example/icon-dark.png',
    );
  });
});

describe('toSameOriginCatalogLogoUrl', () => {
  it('moves a logo onto an app path under the base, keeping host and file name', () => {
    expect(toSameOriginCatalogLogoUrl({ logo: 'https://assets.example/openai.svg', baseUrl: '/' })).toBe(
      '/catalog-logos/https/assets.example/openai.svg',
    );
    expect(toSameOriginCatalogLogoUrl({ logo: 'https://h.example:8443/a/b.png', baseUrl: '/prefix' })).toBe(
      '/prefix/catalog-logos/https/h.example:8443/a/b.png',
    );
  });

  it('keeps the file name last so the dark sibling lookup still works', () => {
    const local = toSameOriginCatalogLogoUrl({ logo: 'https://h.example/x.svg', baseUrl: '/' });
    expect(toDarkCatalogLogoUrl(local)).toBe('/catalog-logos/https/h.example/x-dark.svg');
  });

  it('leaves non-http values alone', () => {
    expect(toSameOriginCatalogLogoUrl({ logo: 'data:image/png;base64,AAAA', baseUrl: '/' })).toBe(
      'data:image/png;base64,AAAA',
    );
    expect(toSameOriginCatalogLogoUrl({ logo: 'not a url', baseUrl: '/' })).toBe('not a url');
  });
});

describe('catalogLogoSrc', () => {
  it('prefers a logo the catalog names, served same-origin', () => {
    expect(catalogLogoSrc({ logo: 'https://h.example/a.svg', kind: 'model', name: 'openai', baseUrl: '/' })).toBe(
      '/catalog-logos/https/h.example/a.svg',
    );
  });

  it('falls back to the bundled logo, then to none', () => {
    const src = catalogLogoSrc({ logo: undefined, kind: 'mcp', name: 'github', baseUrl: '/' });
    expect(src).toBe('catalog-logo:mcp/github');
    expect(bundledCatalogLogo(src ?? '')).toBe(CATALOG_LOGOS['mcp/github']);
    expect(catalogLogoSrc({ logo: undefined, kind: 'mcp', name: 'toString', baseUrl: '/' })).toBeUndefined();
  });
});

describe('bundledCatalogLogo', () => {
  it('ignores ordinary URLs and unknown keys', () => {
    expect(bundledCatalogLogo('https://h.example/a.svg')).toBeUndefined();
    expect(bundledCatalogLogo('catalog-logo:model/nope')).toBeUndefined();
  });
});

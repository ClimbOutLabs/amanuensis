import type { FC, SVGProps } from 'react';

import { CATALOG_LOGOS, type CatalogLogoKind } from '../icons/catalogLogos.js';

function splitCatalogLogoUrl(src: string): { dir: string; base: string; ext: string; suffix: string } | undefined {
  const match = /^(.*\/)?([^/?#]+?)(\.[^./?#]+)([?#].*)?$/.exec(src);
  if (match == null) return undefined;
  const dir = match[1] ?? '';
  const base = match[2];
  const ext = match[3];
  const suffix = match[4] ?? '';
  if (base == null || ext == null) return undefined;
  return { dir, base, ext, suffix };
}

/** Insert `-dark` before the file extension. Undefined when already dark-suffixed or unparseable. */
export function toDarkCatalogLogoUrl(src: string): string | undefined {
  const parts = splitCatalogLogoUrl(src);
  if (parts == null || /-dark$/i.test(parts.base)) return undefined;
  return `${parts.dir}${parts.base}-dark${parts.ext}${parts.suffix}`;
}

/** Strip a trailing `-dark` before the file extension. Undefined when not dark-suffixed or unparseable. */
export function toLightCatalogLogoUrl(src: string): string | undefined {
  const parts = splitCatalogLogoUrl(src);
  if (parts == null || !/-dark$/i.test(parts.base)) return undefined;
  return `${parts.dir}${parts.base.replace(/-dark$/i, '')}${parts.ext}${parts.suffix}`;
}

/**
 * Mode-matched logo URL:
 * - dark → prefer icon-dark.ext (derived from icon.ext, or keep if already dark)
 * - light → prefer icon.ext (derived from icon-dark.ext, or keep if already light)
 */
export function resolveCatalogLogoSrc({ src, mode }: { src: string; mode: 'light' | 'dark' }): string {
  if (mode === 'dark') return toDarkCatalogLogoUrl(src) ?? src;
  return toLightCatalogLogoUrl(src) ?? src;
}

/**
 * Same-origin path for a catalog logo, so the app shell never has to allow the host that serves it:
 * `https://h/a.svg` becomes `<base>catalog-logos/https/h/a.svg`. Non-http(s) values pass through.
 */
export function toSameOriginCatalogLogoUrl({ logo, baseUrl }: { logo: string; baseUrl: string }): string {
  let parsed: URL;
  try {
    parsed = new URL(logo);
  } catch {
    return logo;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return logo;
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return `${base}catalog-logos/${parsed.protocol.slice(0, -1)}/${parsed.host}${parsed.pathname}`;
}

const BUNDLED_CATALOG_LOGO_PREFIX = 'catalog-logo:';

/**
 * Logo `src` for a catalog entry: a logo the catalog names is served same-origin, otherwise the
 * bundled logo for that entry when Aman ships one. Undefined means no logo (the UI draws initials).
 */
export function catalogLogoSrc({
  logo,
  kind,
  name,
  baseUrl,
}: {
  logo: string | undefined;
  kind: CatalogLogoKind;
  name: string;
  baseUrl: string;
}): string | undefined {
  if (logo !== undefined) return toSameOriginCatalogLogoUrl({ logo, baseUrl });
  const key = `${kind}/${name}`;
  return Object.hasOwn(CATALOG_LOGOS, key) ? `${BUNDLED_CATALOG_LOGO_PREFIX}${key}` : undefined;
}

/** Spreads `{ logo }` only when there is one, for shapes where `logo` is optional. */
export function withLogo(logo: string | undefined): { logo?: string } {
  return logo === undefined ? {} : { logo };
}

/** The bundled logo a `catalogLogoSrc` value points at, or undefined for an ordinary image URL. */
export function bundledCatalogLogo(src: string): FC<SVGProps<SVGSVGElement>> | undefined {
  if (!src.startsWith(BUNDLED_CATALOG_LOGO_PREFIX)) return undefined;
  const key = src.slice(BUNDLED_CATALOG_LOGO_PREFIX.length);
  return Object.hasOwn(CATALOG_LOGOS, key) ? CATALOG_LOGOS[key] : undefined;
}

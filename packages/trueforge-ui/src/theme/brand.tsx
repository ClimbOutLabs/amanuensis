'use client';

import { useContext } from 'react';

import { ThemeContext } from './ThemeProvider.js';
import type { BrandConfig, BrandLogoConfig } from './types.js';

const DEFAULT_BRAND_NAME = 'Amanuensis';

/** Expanded / collapsed chrome choices derived from `theme.brand.mode`. */
export type BrandChrome = {
  expandedVariant: 'icon' | 'logo';
  collapsedVariant: 'icon';
  /** Whether to render `name` as visible text beside the mark in expanded chrome. */
  showTitle: boolean;
};

/**
 * Maps `brand.mode` to layout chrome. Layouts should not re-derive field combinations.
 */
export function resolveBrandChrome(brand: Partial<BrandConfig> | undefined): BrandChrome {
  switch (brand?.mode) {
    case 'logo':
      return { expandedVariant: 'logo', collapsedVariant: 'icon', showTitle: false };
    case 'icon-only':
      return { expandedVariant: 'icon', collapsedVariant: 'icon', showTitle: false };
    case 'icon-title':
      return { expandedVariant: 'icon', collapsedVariant: 'icon', showTitle: true };
    default:
      // Omit `brand` (or incomplete Partial) → default Amanuensis wordmark.
      return { expandedVariant: 'logo', collapsedVariant: 'icon', showTitle: false };
  }
}

/** Mode-matched source, falling back to the other mode then the mode-agnostic `src`. */
function resolveImageSrc({
  image,
  mode,
}: {
  image: string | BrandLogoConfig;
  mode: 'light' | 'dark';
}): string | undefined {
  if (typeof image === 'string') return image;
  const preferred = mode === 'dark' ? image.dark : image.light;
  return preferred ?? image.light ?? image.dark ?? image.src;
}

/** Configured display name, or the SDK default when no custom brand is set. */
export function useBrandName(): string | undefined {
  const brand = useContext(ThemeContext)?.brand;
  if (brand?.name != null) return brand.name;
  return brand?.mode == null ? DEFAULT_BRAND_NAME : undefined;
}

/**
 * The default mark: an inline glyph, so no packaged logo asset ships with the
 * SDK. Used for both the `icon` and `logo` variants when no brand image is
 * configured.
 */
function DefaultMark({ className, label }: { className?: string; label?: string }) {
  return (
    <svg className={className} viewBox="0 0 120 120" role="img" aria-label={label} xmlns="http://www.w3.org/2000/svg">
      <rect x="4" y="4" width="112" height="112" rx="28" fill="currentColor" />
      <path d="M60 25 34 94h13l5-15h16l5 15h13L60 25Zm0 24 5 18H55l5-18Z" fill="#f7f1e6" />
    </svg>
  );
}

/**
 * The product mark resolved against the active theme mode. Compact surfaces use
 * `icon`; expanded surfaces use `logo` and fall back to `icon`.
 */
export function BrandLogo({ className, variant = 'icon' }: { className?: string; variant?: 'icon' | 'logo' }) {
  const theme = useContext(ThemeContext);
  const brand = theme?.brand;
  const name = useBrandName();
  const label = name ?? DEFAULT_BRAND_NAME;
  const mode = theme?.mode ?? 'light';
  const preferredImage = variant === 'logo' ? brand?.logo : brand?.icon;
  const preferredSrc = preferredImage == null ? undefined : resolveImageSrc({ image: preferredImage, mode });
  const icon = brand?.icon;
  const src = preferredSrc ?? (variant === 'logo' && icon != null ? resolveImageSrc({ image: icon, mode }) : undefined);

  if (src == null) {
    return <DefaultMark className={className} label={label} />;
  }

  const image = <img src={src} alt={label} className={className} />;
  const href = brand?.href;
  if (href == null) return image;

  return (
    <a href={href} aria-label={label} className="inline-flex items-center">
      {image}
    </a>
  );
}

declare module './SlotsProvider.js' {
  interface AtomSlots {
    BrandLogo: typeof BrandLogo;
  }
}

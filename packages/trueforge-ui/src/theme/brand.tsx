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

/** Shared by every surface that draws the mark, so none of them re-derive it. */
export const BRAND_GLYPH_VIEW_BOX = '0 0 120 120';

/**
 * The two nib strokes of the A: a thin left upstroke and a thick right
 * downstroke, both cut off square at the same angle the way a broad nib leaves
 * the paper. The short facet across the apex is the nib width, not a
 * rounded point.
 */
export const BRAND_GLYPH_STEM_PATH = 'M62 10 74 15 112 106 87 112 59 40 28 106 11 112Z';

/**
 * The crossbar. Drawn in ink rather than the accent so the mark still reads as
 * an A wherever the accent variable is unavailable.
 */
export const BRAND_GLYPH_BAR_PATH = 'M35 74Q62 68 97 62L98 74Q63 79 36 86Z';

/**
 * The scribe's exit stroke, continuing the crossbar past the right stem and
 * tapering to the point where the nib lifts. Ornament only, and it shares its
 * two start points with the crossbar so the line reads as one.
 */
export const BRAND_GLYPH_FLOURISH_PATH = 'M97 62C107 60 113 56 119 50 114 60 107 69 98 74Z';

/**
 * The Amanuensis mark. The ink takes `currentColor` so it inherits the
 * surrounding text color in either theme mode; the flourish takes the theme's
 * brass accent and falls back to ink.
 *
 * Exported so other chrome can draw the same mark without redrawing it.
 */
export function BrandGlyph({ className, label }: { className?: string; label?: string }) {
  return (
    <svg
      className={className}
      viewBox={BRAND_GLYPH_VIEW_BOX}
      role="img"
      aria-label={label}
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d={BRAND_GLYPH_STEM_PATH} fill="currentColor" />
      <path d={BRAND_GLYPH_BAR_PATH} fill="currentColor" />
      <path d={BRAND_GLYPH_FLOURISH_PATH} fill="var(--brand-accent, currentColor)" />
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
    return <BrandGlyph className={className} label={label} />;
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

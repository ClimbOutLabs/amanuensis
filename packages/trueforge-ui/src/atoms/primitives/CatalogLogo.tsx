'use client';

import { useEffect, useState, type ImgHTMLAttributes } from 'react';

import { useThemeMode } from '../../theme/SlotsProvider.js';
import { bundledCatalogLogo, resolveCatalogLogoSrc } from '../../utils/catalogLogo.js';

export type CatalogLogoProps = Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> & {
  src: string;
};

/**
 * Catalog logo with mode-matched siblings:
 * - `…/icon.png` in dark mode → try `…/icon-dark.png`, else catalog URL
 * - `…/icon-dark.png` in light mode → try `…/icon.png`, else catalog URL
 * A bundled logo (see `catalogLogoSrc`) draws inline in the text colour, so it needs no sibling.
 */
export function CatalogLogo({ src, alt = '', onError, ...props }: CatalogLogoProps) {
  const mode = useThemeMode();
  const preferred = resolveCatalogLogoSrc({ src, mode });
  const [failedPreferred, setFailedPreferred] = useState(false);

  useEffect(() => {
    setFailedPreferred(false);
  }, [src, mode, preferred]);

  const canFallback = preferred !== src;
  const resolved = failedPreferred && canFallback ? src : preferred;

  const Bundled = bundledCatalogLogo(src);
  if (Bundled !== undefined) {
    return (
      <Bundled
        className={props.className}
        style={props.style}
        role="img"
        aria-label={alt === '' ? undefined : alt}
        aria-hidden={alt === '' ? true : undefined}
      />
    );
  }

  return (
    <img
      {...props}
      key={resolved}
      src={resolved}
      alt={alt}
      onError={event => {
        if (canFallback && !failedPreferred) {
          setFailedPreferred(true);
          return;
        }
        onError?.(event);
      }}
    />
  );
}

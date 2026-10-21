'use client';

import { useEffect, useState } from 'react';

import { useOptionalCatalogServer } from '../server/ServerContext.js';
import { hasGoogleSetup, type GoogleFeature } from '../server/googleSetup.js';

/**
 * The Google features this owner has granted, read from the catalog. Null while the read is in
 * flight or when the host has no Google port, so callers can keep prompts that need Google hidden.
 */
export function useGrantedGoogleFeatures(): readonly GoogleFeature[] | null {
  const catalog = useOptionalCatalogServer();
  const [granted, setGranted] = useState<readonly GoogleFeature[] | null>(null);

  useEffect(() => {
    if (catalog === null || !hasGoogleSetup(catalog)) return;
    const state = { cancelled: false };
    catalog
      .getGoogleStatus()
      .then(status => {
        if (!state.cancelled) setGranted(status.features.filter(item => item.granted).map(item => item.feature));
      })
      .catch(() => {
        // A failed read keeps the Google prompts hidden rather than offering ones that may not work.
        if (!state.cancelled) setGranted([]);
      });
    return () => {
      state.cancelled = true;
    };
  }, [catalog]);

  return granted;
}

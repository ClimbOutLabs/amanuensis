'use client';

import type { FC } from 'react';

import { Icon } from '../icons/Icon.js';
import { useOptionalSentinelApiState } from './SentinelApiContext.js';

/**
 * Persistent app-shell indicator, visible only while the user has offline mode on.
 * Offline mode auto-denies external Tier 3 actions without showing an approval card.
 */
export const OfflineIndicator: FC = () => {
  const offline = useOptionalSentinelApiState()?.settings?.offline_mode ?? false;
  if (!offline) return null;
  return (
    <p
      role="status"
      className="flex items-center gap-1.5 rounded-md border border-warning-bg/40 bg-warning-bg/10 px-2.5 py-1.5 text-xs font-medium text-text-primary"
      title="Offline mode is on. External actions that need approval are denied automatically."
    >
      <Icon name="plug" className="shrink-0" aria-hidden="true" />
      <span>Offline mode</span>
    </p>
  );
};

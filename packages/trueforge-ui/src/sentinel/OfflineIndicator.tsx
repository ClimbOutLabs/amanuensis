'use client';

import type { FC } from 'react';

import { Icon } from '../icons/Icon.js';
import { useOptionalSentinelApiState } from './SentinelApiContext.js';

/**
 * Persistent app-shell indicator, visible only while the user has offline mode on. `compact` is
 * the icon alone, for the collapsed rail.
 * Offline mode auto-denies external actions without showing an approval card.
 */
export const OfflineIndicator: FC<{ compact?: boolean }> = ({ compact = false }) => {
  const offline = useOptionalSentinelApiState()?.settings?.offline_mode ?? false;
  if (!offline) return null;
  if (compact) {
    return (
      <p
        role="status"
        aria-label="Offline mode is on"
        className="flex justify-center text-text-primary"
        title="Offline mode is on. External actions that need approval are denied automatically."
      >
        <Icon name="plug" aria-hidden="true" />
      </p>
    );
  }
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

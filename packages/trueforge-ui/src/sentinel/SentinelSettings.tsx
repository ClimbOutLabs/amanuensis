'use client';

import { useState, type FC } from 'react';

import { Switch } from '../atoms/primitives/Switch.js';
import { useOptionalSentinelApiState } from './SentinelApiContext.js';

/**
 * Settings > Permissions: the user-only offline mode toggle. While offline mode is on,
 * actions outside this device are auto-denied without an approval card, and the
 * persistent offline indicator shows in the app shell.
 */
export const SentinelSettings: FC = () => {
  const sentinel = useOptionalSentinelApiState();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (sentinel === null) {
    return <p className="text-sm text-text-secondary">Permissions are not available in this setup.</p>;
  }

  const offline = sentinel.settings?.offline_mode ?? false;

  const handleChange = async (next: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await sentinel.updateSettings({ offline_mode: next });
    } catch (err) {
      setError(err instanceof Error && err.message !== '' ? err.message : 'Request failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-base font-semibold text-text-primary">Permissions</h2>
        <p className="mt-1 text-sm text-text-secondary">How Aman asks before acting for you.</p>
      </div>

      <div className="flex items-start justify-between gap-4 rounded-lg border border-border p-4">
        <div>
          <p className="text-sm font-medium text-text-primary">Offline mode</p>
          <p className="mt-1 text-sm text-text-secondary">
            While on, actions outside this device that need your approval are denied automatically. Reading and your
            allowed workspace actions still work.
          </p>
          {error !== null && (
            <p className="mt-2 text-xs text-failure-bg" role="alert">
              {error}
            </p>
          )}
        </div>
        <Switch
          size="md"
          checked={offline}
          disabled={busy || sentinel.settings === null}
          onCheckedChange={handleChange}
          aria-label="Offline mode"
        />
      </div>
    </div>
  );
};

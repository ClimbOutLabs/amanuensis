'use client';

import { useState, type FC } from 'react';

import { Switch } from '../atoms/primitives/Switch.js';
import { useOptionalSentinelApiState } from './SentinelApiContext.js';

/**
 * Settings > Permissions: the user-only offline mode toggle and the web search switch. While
 * offline mode is on, actions outside this device are auto-denied without an approval card, and
 * the persistent offline indicator shows in the app shell. The search switch decides whether the
 * connector you designated as your search provider asks before each search.
 */
export const SentinelSettings: FC = () => {
  const sentinel = useOptionalSentinelApiState();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);

  if (sentinel === null) {
    return (
      <p className="text-sm text-text-secondary">
        Permissions settings are unavailable: the host did not provide a Sentinel API.
      </p>
    );
  }

  const offline = sentinel.settings?.offline_mode ?? false;
  const searchWithoutAsking = sentinel.settings?.search_without_asking ?? true;

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

  const handleSearchChange = async (next: boolean) => {
    setBusy(true);
    setSearchError(null);
    try {
      await sentinel.updateSettings({ search_without_asking: next });
    } catch (err) {
      setSearchError(err instanceof Error && err.message !== '' ? err.message : 'Request failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-base font-semibold text-text-primary">Permissions</h2>
        <p className="mt-1 text-sm text-text-secondary">How the assistant asks before acting on your behalf.</p>
      </div>

      <div className="flex items-start justify-between gap-4 rounded-lg border border-border p-4">
        <div>
          <p className="text-sm font-medium text-text-primary">Offline mode</p>
          <p className="mt-1 text-sm text-text-secondary">
            While on, actions outside this device that would need your approval are denied automatically instead of
            showing an approval card. Reads and workspace actions you allowed are unaffected.
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

      <div className="flex items-start justify-between gap-4 rounded-lg border border-border p-4">
        <div>
          <p className="text-sm font-medium text-text-primary">Web searches</p>
          <p className="mt-1 text-sm text-text-secondary">
            {searchWithoutAsking
              ? 'Run without asking. Searches through the connector you set as your search provider run on their own and show a Searched chip.'
              : 'Ask. Every web search shows an approval card with the exact query before it runs.'}
          </p>
          <p className="mt-1 text-sm text-text-secondary">
            {"The search service sees the search words and this computer's internet address."}
          </p>
          {searchError !== null && (
            <p className="mt-2 text-xs text-failure-bg" role="alert">
              {searchError}
            </p>
          )}
        </div>
        <Switch
          size="md"
          checked={searchWithoutAsking}
          disabled={busy || sentinel.settings === null}
          onCheckedChange={handleSearchChange}
          aria-label="Run web searches without asking"
        />
      </div>
    </div>
  );
};

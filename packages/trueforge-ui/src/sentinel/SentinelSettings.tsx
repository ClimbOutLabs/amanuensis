'use client';

import { useState, type FC } from 'react';

import { Switch } from '../atoms/primitives/Switch.js';
import { APPROVAL_CHOICES } from './approvalChoices.js';
import { useOptionalSentinelApiState } from './SentinelApiContext.js';

/**
 * Settings > Permissions: the user-only offline mode toggle, the web search switch and the maps
 * switch. While offline mode is on, actions outside this device are auto-denied without an approval
 * card, and the persistent offline indicator shows in the app shell. The search switch decides whether
 * the connector you designated as your search provider asks before each search. The maps switch
 * decides whether maps ask first. After this chat reads mail or calendar, a map is checked against that text first.
 */
export const SentinelSettings: FC = () => {
  const sentinel = useOptionalSentinelApiState();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [mapsError, setMapsError] = useState<string | null>(null);

  if (sentinel === null) {
    return (
      <p className="text-sm text-text-secondary">
        Permissions settings are unavailable: the host did not provide a Sentinel API.
      </p>
    );
  }

  const offline = sentinel.settings?.offline_mode ?? false;
  const searchWithoutAsking = sentinel.settings?.search_without_asking ?? true;
  const mapsWithoutAsking = sentinel.settings?.maps_without_asking ?? false;

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

  const handleMapsChange = async (next: boolean) => {
    setBusy(true);
    setMapsError(null);
    try {
      await sentinel.updateSettings({ maps_without_asking: next });
    } catch (err) {
      setMapsError(err instanceof Error && err.message !== '' ? err.message : 'Request failed.');
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

      <div className="rounded-lg border border-border p-4">
        <p className="text-sm font-medium text-text-primary">When the assistant asks, you can choose</p>
        <dl className="mt-2 space-y-1.5 text-sm">
          {[
            APPROVAL_CHOICES.approve,
            APPROVAL_CHOICES.approveForChat,
            APPROVAL_CHOICES.alwaysAllow,
            APPROVAL_CHOICES.deny,
          ].map(choice => (
            <div key={choice.label} className="flex flex-col sm:flex-row sm:gap-2">
              <dt className="shrink-0 font-medium text-text-primary sm:w-44">{choice.label}</dt>
              <dd className="text-text-secondary">{choice.hint}</dd>
            </div>
          ))}
        </dl>
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
            {
              "Searches go to Parallel, which sees the search words and this instance's internet address. To stop searching, remove the parallel-web connector or turn on Offline mode."
            }
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

      <div className="flex items-start justify-between gap-4 rounded-lg border border-border p-4">
        <div>
          <p className="text-sm font-medium text-text-primary">Maps</p>
          <p className="mt-1 text-sm text-text-secondary">
            {mapsWithoutAsking
              ? 'Maps run without asking. After this chat reads your email or calendar, a map asks instead if it would share a name, email address or number from them.'
              : 'Maps ask before each one.'}
          </p>
          {mapsError !== null && (
            <p className="mt-2 text-xs text-failure-bg" role="alert">
              {mapsError}
            </p>
          )}
        </div>
        <Switch
          size="md"
          checked={mapsWithoutAsking}
          disabled={busy || sentinel.settings === null}
          onCheckedChange={handleMapsChange}
          aria-label="Show maps without asking"
        />
      </div>
    </div>
  );
};

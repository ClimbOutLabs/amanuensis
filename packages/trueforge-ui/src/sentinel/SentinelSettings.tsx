'use client';

import { useState, type FC } from 'react';

import { Switch } from '../atoms/primitives/Switch.js';
import { APPROVAL_CHOICES } from './approvalChoices.js';
import { useOptionalSentinelApiState } from './SentinelApiContext.js';
import { Tier2RelaxationToggle } from './Tier2RelaxationToggle.js';
import { TIER2_ACTION_KINDS, TIER2_ACTION_LABELS, type Tier2ActionKind } from './types.js';

/**
 * Settings > Permissions: the user-only offline mode toggle, the web search switch, the maps
 * switch and the sandbox switch. While offline mode is on, actions outside this device are auto-denied without an approval
 * card, and the persistent offline indicator shows in the app shell. The search switch decides whether
 * the connector you designated as your search provider asks before each search. The maps switch
 * decides whether maps ask first. After this chat reads mail or calendar, a map is checked against that text first.
 */
export const SentinelSettings: FC = () => {
  const sentinel = useOptionalSentinelApiState();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sandboxError, setSandboxError] = useState<string | null>(null);
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
  const sandboxWithoutAsking = sentinel.settings?.sandbox_without_asking ?? true;

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

  const handleTier2Toggle = async (input: { actionType: Tier2ActionKind; relaxed: boolean }) => {
    // Derived from the latest saved settings, not this render's snapshot, so a toggle of
    // another kind that is still saving is not overwritten.
    await sentinel.updateSettings(({ tier2_auto_allow: current }) => ({
      tier2_auto_allow: input.relaxed
        ? current.includes(input.actionType)
          ? current
          : [...current, input.actionType]
        : current.filter(kind => kind !== input.actionType),
    }));
  };

  const handleSandboxChange = async (next: boolean) => {
    setBusy(true);
    setSandboxError(null);
    try {
      await sentinel.updateSettings({ sandbox_without_asking: next });
    } catch (err) {
      setSandboxError(err instanceof Error && err.message !== '' ? err.message : 'Request failed.');
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

      <div className="flex items-start justify-between gap-4 rounded-lg border border-border p-4">
        <div>
          <p className="text-sm font-medium text-text-primary">Sandbox</p>
          <p className="mt-1 text-sm text-text-secondary">
            {sandboxWithoutAsking
              ? 'Aman can make new files and run the scripts it wrote in this chat without asking. Changing a file that already exists, running scripts from your repository, and running tests still ask. Anything that leaves the sandbox still asks.'
              : 'Work inside the sandbox asks before it runs.'}
          </p>
          {sandboxError !== null && (
            <p className="mt-2 text-xs text-failure-bg" role="alert">
              {sandboxError}
            </p>
          )}
        </div>
        <Switch
          size="md"
          checked={sandboxWithoutAsking}
          disabled={busy || sentinel.settings === null}
          onCheckedChange={handleSandboxChange}
          aria-label="Run code in the sandbox without asking"
        />
      </div>

      <div className="rounded-lg border border-border p-4">
        <p className="text-sm font-medium text-text-primary">Always allow</p>
        <p className="mt-1 text-sm text-text-secondary">
          Off means the assistant asks before each of these. On means it runs them without asking.
        </p>
        <ul className="mt-3 space-y-2">
          {TIER2_ACTION_KINDS.map(kind => (
            <li key={kind} className="flex items-center justify-between gap-2 text-sm">
              <span className="min-w-0 text-text-primary">{TIER2_ACTION_LABELS[kind]}</span>
              <Tier2RelaxationToggle
                actionType={kind}
                relaxed={sentinel.settings?.tier2_auto_allow.includes(kind) ?? false}
                disabled={sentinel.settings === null}
                onChange={handleTier2Toggle}
              />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
};

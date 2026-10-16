'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState, type FC, type ReactNode } from 'react';

import type { SentinelApi, SentinelUserSettings } from './types.js';

/** A settings patch, or a function deriving one from the latest saved settings. */
export type SentinelSettingsChange =
  Partial<SentinelUserSettings> | ((current: SentinelUserSettings) => Partial<SentinelUserSettings>);

export type SentinelApiState = {
  api: SentinelApi;
  /** `null` until the first settings read resolves; consumers render nothing meanwhile. */
  settings: SentinelUserSettings | null;
  settingsError: string | null;
  refreshSettings: () => Promise<void>;
  /**
   * Applies a settings change through the host API and publishes the returned settings,
   * so the offline indicator and the Settings section stay in sync with no reload.
   * Changes run one at a time, and a function change sees the settings the previous one
   * saved, so two quick edits of the same list cannot overwrite each other.
   */
  updateSettings: (change: SentinelSettingsChange) => Promise<SentinelUserSettings>;
};

const SentinelApiContext = createContext<SentinelApiState | null>(null);

function readErrorMessage(error: unknown): string {
  return error instanceof Error && error.message !== '' ? error.message : 'Request failed.';
}

/**
 * Hosts that serve the Sentinel backend wrap their tree in this provider. Besides the
 * raw API it owns the user settings, loaded once on mount: the persistent offline
 * indicator and the Settings section both read from here, so a toggle in Settings
 * updates the indicator immediately. Absent the provider, every Sentinel hook returns
 * `null` and all Sentinel UI stays hidden.
 */
export const SentinelApiProvider: FC<{ api: SentinelApi; children: ReactNode }> = ({ api, children }) => {
  const [settings, setSettings] = useState<SentinelUserSettings | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const latestSettings = useRef<SentinelUserSettings | null>(null);
  const updateQueue = useRef<Promise<unknown>>(Promise.resolve());

  const refreshSettings = useCallback(async () => {
    try {
      const loaded = await api.getUserSettings();
      latestSettings.current = loaded;
      setSettings(loaded);
      setSettingsError(null);
    } catch (error) {
      setSettingsError(readErrorMessage(error));
    }
  }, [api]);

  useEffect(() => {
    void refreshSettings();
  }, [refreshSettings]);

  const updateSettings = useCallback(
    (change: SentinelSettingsChange) => {
      const run = async () => {
        const patch =
          typeof change === 'function' ? change(latestSettings.current ?? (await api.getUserSettings())) : change;
        const next = await api.updateUserSettings(patch);
        latestSettings.current = next;
        setSettings(next);
        setSettingsError(null);
        return next;
      };
      const result = updateQueue.current.then(run, run);
      updateQueue.current = result.catch(() => undefined);
      return result;
    },
    [api],
  );

  const state: SentinelApiState = {
    api,
    settings,
    settingsError,
    refreshSettings,
    updateSettings,
  };
  return <SentinelApiContext.Provider value={state}>{children}</SentinelApiContext.Provider>;
};

export function useOptionalSentinelApiState(): SentinelApiState | null {
  return useContext(SentinelApiContext);
}

/** The raw host API; `null` outside a `SentinelApiProvider`. */
export function useOptionalSentinelApi(): SentinelApi | null {
  return useContext(SentinelApiContext)?.api ?? null;
}

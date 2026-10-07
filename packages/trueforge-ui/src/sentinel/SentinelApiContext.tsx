'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type FC,
  type ReactNode,
} from 'react';

import { parseUserSettings, type SentinelApi, type SentinelUserSettings } from './types.js';

export type SentinelApiState = {
  api: SentinelApi;
  /** `null` until the first settings read resolves; consumers render nothing meanwhile. */
  settings: SentinelUserSettings | null;
  settingsError: string | null;
  refreshSettings: () => Promise<void>;
  /**
   * Applies a settings patch through the host API and publishes the returned settings,
   * so the offline indicator and the Settings section stay in sync with no reload.
   */
  updateSettings: (patch: Partial<SentinelUserSettings>) => Promise<SentinelUserSettings>;
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
export const SentinelApiProvider: FC<{ api: SentinelApi; children: ReactNode }> = ({
  api,
  children,
}) => {
  const [settings, setSettings] = useState<SentinelUserSettings | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);

  const refreshSettings = useCallback(async () => {
    try {
      const next = parseUserSettings(await api.getUserSettings());
      setSettings(next);
      setSettingsError(null);
    } catch (error) {
      setSettingsError(readErrorMessage(error));
    }
  }, [api]);

  useEffect(() => {
    void refreshSettings();
  }, [refreshSettings]);

  const updateSettings = useCallback(
    async (patch: Partial<SentinelUserSettings>) => {
      const next = parseUserSettings(await api.updateUserSettings(patch));
      setSettings(next);
      setSettingsError(null);
      return next;
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

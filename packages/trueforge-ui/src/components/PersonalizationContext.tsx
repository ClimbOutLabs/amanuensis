'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type FC, type ReactNode } from 'react';

export type PersonalizationProfile = {
  assistant_name: string | null;
  assistant_identity: string | null;
  voice_guidance: string | null;
  user_profile: string | null;
  pinned_preferences: string[];
  /** Host-learned markdown document; null until the learning pass writes one. */
  learned_profile: string | null;
  /**
   * Whether the host may rewrite the learned document after a completed turn. Absent when the
   * host has not shown that it knows the field, which is not the same as off: the write request
   * is strict, so a host that does not know the field rejects it outright. Render an absent
   * switch as off; never send a value the host never sent.
   */
  learning_enabled?: boolean;
};

export type PersonalizationApi = {
  getProfile: () => Promise<PersonalizationProfile | null>;
  updateProfile: (profile: PersonalizationProfile) => Promise<PersonalizationProfile>;
  deleteProfile: () => Promise<void>;
};

/**
 * The blank form, used before a profile exists and after one is cleared. The switch is left out
 * rather than set to false: nothing has expressed a choice yet, and a host that does not know
 * the field must not be sent one on the save that first creates the profile.
 */
export const EMPTY_PERSONALIZATION_PROFILE: PersonalizationProfile = {
  assistant_name: null,
  assistant_identity: null,
  voice_guidance: null,
  user_profile: null,
  pinned_preferences: [],
  learned_profile: null,
};

type PersonalizationContextValue = {
  profile: PersonalizationProfile | null;
  loading: boolean;
  loadError: string | null;
  updateProfile: (profile: PersonalizationProfile) => Promise<PersonalizationProfile>;
  deleteProfile: () => Promise<void>;
  reload: () => Promise<void>;
};

const PersonalizationContext = createContext<PersonalizationContextValue | null>(null);

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export const PersonalizationProvider: FC<{ api: PersonalizationApi; children: ReactNode }> = ({ api, children }) => {
  const [profile, setProfile] = useState<PersonalizationProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setProfile(await api.getProfile());
    } catch (error) {
      setLoadError(errorMessage(error, 'Could not load personalization.'));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const updateProfile = useCallback(
    async (next: PersonalizationProfile) => {
      const saved = await api.updateProfile(next);
      setProfile(saved);
      return saved;
    },
    [api],
  );

  const deleteProfile = useCallback(async () => {
    await api.deleteProfile();
    setProfile(null);
  }, [api]);

  const value = useMemo(
    () => ({ profile, loading, loadError, updateProfile, deleteProfile, reload }),
    [profile, loading, loadError, updateProfile, deleteProfile, reload],
  );

  return <PersonalizationContext.Provider value={value}>{children}</PersonalizationContext.Provider>;
};

export function useOptionalPersonalization(): PersonalizationContextValue | null {
  return useContext(PersonalizationContext);
}

export function usePersonalization(): PersonalizationContextValue {
  const context = useOptionalPersonalization();
  if (context == null) {
    throw new Error('usePersonalization must be used within a PersonalizationProvider.');
  }
  return context;
}

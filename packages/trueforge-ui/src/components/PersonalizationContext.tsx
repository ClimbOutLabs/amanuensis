'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type FC, type ReactNode } from 'react';
import { assistantDisplayName } from '../utils/assistantName.js';

import type { HelpAreaId } from '@truefoundry/trueforge-core/schemas/personalizationHelpAreas';

export type PersonalizationProfile = {
  assistant_name: string | null;
  assistant_identity: string | null;
  voice_guidance: string | null;
  /** What the user is called; the first thing a new user is asked for. */
  user_name: string | null;
  /** How the assistant should address the user: a short form, a title, pronouns. */
  address_as: string | null;
  user_profile: string | null;
  pinned_preferences: string[];
  /** The areas the person picked for the Tour, in the order picked; empty when none. */
  help_areas: HelpAreaId[];
  /** Host-learned markdown document; null until the learning pass writes one. */
  learned_profile: string | null;
  /**
   * Whether the host may rewrite the learned document after a completed turn. Absent when the
   * host has not shown that it knows the field, which is not the same as off: the write request
   * is strict, so a host that does not know the field rejects it outright. Render an absent
   * switch as off; never send a value the host never sent.
   */
  learning_enabled?: boolean;
  /**
   * The saved version this copy was read from. A save sends it back so the host can refuse a
   * save made from an older copy. Absent before a profile exists.
   */
  revision?: number;
};

/** The host refused a save because the profile changed after this copy was read. */
export class PersonalizationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PersonalizationConflictError';
  }
}

function keepEdit<T>({ base, edited, latest }: { base: T; edited: T; latest: T }): T {
  return JSON.stringify(edited) === JSON.stringify(base) ? latest : edited;
}

/**
 * Carries the person's edits onto the newest saved profile. A field they changed keeps their
 * value; a field they left alone takes the newest value, so text the assistant learned while
 * the page was open is not put back to what the page first showed.
 */
export function mergeProfileEdits({
  base,
  edited,
  latest,
}: {
  base: PersonalizationProfile;
  edited: PersonalizationProfile;
  latest: PersonalizationProfile;
}): PersonalizationProfile {
  const learningEnabled = keepEdit({
    base: base.learning_enabled,
    edited: edited.learning_enabled,
    latest: latest.learning_enabled,
  });
  return {
    assistant_name: keepEdit({
      base: base.assistant_name,
      edited: edited.assistant_name,
      latest: latest.assistant_name,
    }),
    assistant_identity: keepEdit({
      base: base.assistant_identity,
      edited: edited.assistant_identity,
      latest: latest.assistant_identity,
    }),
    voice_guidance: keepEdit({
      base: base.voice_guidance,
      edited: edited.voice_guidance,
      latest: latest.voice_guidance,
    }),
    user_name: keepEdit({ base: base.user_name, edited: edited.user_name, latest: latest.user_name }),
    address_as: keepEdit({ base: base.address_as, edited: edited.address_as, latest: latest.address_as }),
    user_profile: keepEdit({ base: base.user_profile, edited: edited.user_profile, latest: latest.user_profile }),
    pinned_preferences: keepEdit({
      base: base.pinned_preferences,
      edited: edited.pinned_preferences,
      latest: latest.pinned_preferences,
    }),
    help_areas: keepEdit({ base: base.help_areas, edited: edited.help_areas, latest: latest.help_areas }),
    learned_profile: keepEdit({
      base: base.learned_profile,
      edited: edited.learned_profile,
      latest: latest.learned_profile,
    }),
    ...(learningEnabled === undefined ? {} : { learning_enabled: learningEnabled }),
    ...(latest.revision === undefined ? {} : { revision: latest.revision }),
  };
}

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
  user_name: null,
  address_as: null,
  user_profile: null,
  pinned_preferences: [],
  help_areas: [],
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
      let saved: PersonalizationProfile;
      try {
        saved = await api.updateProfile(next);
      } catch (error) {
        if (!(error instanceof PersonalizationConflictError)) {
          throw error;
        }
        // The profile moved on while the page was open, most often because the assistant
        // learned something. Save the person's edits on top of the newest copy, once.
        const latest = await api.getProfile();
        if (latest === null) {
          throw error;
        }
        saved = await api.updateProfile(
          mergeProfileEdits({ base: profile ?? EMPTY_PERSONALIZATION_PROFILE, edited: next, latest }),
        );
      }
      setProfile(saved);
      return saved;
    },
    [api, profile],
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

/** The assistant's display name from the profile, or the default before one is chosen. */
export function useAssistantDisplayName(): string {
  return assistantDisplayName(useOptionalPersonalization()?.profile?.assistant_name);
}

export function usePersonalization(): PersonalizationContextValue {
  const context = useOptionalPersonalization();
  if (context == null) {
    throw new Error('usePersonalization must be used within a PersonalizationProvider.');
  }
  return context;
}

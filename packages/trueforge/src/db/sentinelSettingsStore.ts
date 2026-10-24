import { TIER2_ACTION_KINDS } from '@truefoundry/trueforge-core/core';
import type { SentinelUserSettings } from '../schemas/sentinelSettings';

export interface SentinelSettingsOwner {
  tenant_id: string;
  created_by: string;
}

export interface PatchSentinelSettingsInput extends SentinelSettingsOwner {
  /** Undefined keeps the stored value. */
  offline_mode: boolean | undefined;
  /** Undefined keeps the stored set; an array replaces it. */
  tier2_auto_allow: SentinelUserSettings['tier2_auto_allow'] | undefined;
  /** Undefined keeps the stored value. */
  search_without_asking: boolean | undefined;
  /** Undefined keeps the stored value. */
  maps_without_asking: boolean | undefined;
  /** Undefined keeps the stored value. */
  sandbox_without_asking: boolean | undefined;
}

/**
 * Per-user Sentinel preferences. A user with no row reads as the safe defaults
 * (online, nothing relaxed, searches run without asking), so Tier 2 asks until the user opts out per kind.
 */
export interface ISentinelSettingsStore<TTransaction = never> {
  get(input: SentinelSettingsOwner, transaction?: TTransaction): Promise<SentinelUserSettings>;
  /** Merges the provided fields into the user's settings and returns the result. */
  patch(input: PatchSentinelSettingsInput, transaction?: TTransaction): Promise<SentinelUserSettings>;
}

export const DEFAULT_SENTINEL_USER_SETTINGS: SentinelUserSettings = {
  offline_mode: false,
  tier2_auto_allow: [],
  search_without_asking: true,
  maps_without_asking: true,
  sandbox_without_asking: true,
};

/** Deduplicated kinds in the canonical kind order, so equal sets always store and read identically. */
export function normalizeTier2AutoAllow(
  kinds: SentinelUserSettings['tier2_auto_allow'],
): SentinelUserSettings['tier2_auto_allow'] {
  return TIER2_ACTION_KINDS.filter(kind => kinds.includes(kind));
}

import type { SentinelServices } from '@truefoundry/trueforge-core/core';
import type { ISentinelSettingsStore } from '../db/sentinelSettingsStore';

/**
 * Per-user readers the classifier and dispatch guard consult on every call, so a
 * settings change applies to the user's next tool call without a restart.
 */
export function sentinelSettingsServices(
  store: ISentinelSettingsStore,
): Pick<SentinelServices, 'isOffline' | 'tier2AutoAllow' | 'searchWithoutAsking' | 'mapsWithoutAsking'> {
  return {
    isOffline: async input => (await store.get(input)).offline_mode,
    tier2AutoAllow: async input => new Set((await store.get(input)).tier2_auto_allow),
    searchWithoutAsking: async input => (await store.get(input)).search_without_asking,
    mapsWithoutAsking: async input => (await store.get(input)).maps_without_asking,
  };
}

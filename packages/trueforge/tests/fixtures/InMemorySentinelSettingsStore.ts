import {
  DEFAULT_SENTINEL_USER_SETTINGS,
  normalizeTier2AutoAllow,
  type ISentinelSettingsStore,
  type PatchSentinelSettingsInput,
  type SentinelSettingsOwner,
} from '../../src/db/sentinelSettingsStore';
import type { SentinelUserSettings } from '../../src/schemas/sentinelSettings';

/** Reference implementation of the store contract for tests that need no database. */
export class InMemorySentinelSettingsStore implements ISentinelSettingsStore {
  readonly #rows = new Map<string, SentinelUserSettings>();

  get(input: SentinelSettingsOwner): Promise<SentinelUserSettings> {
    return Promise.resolve(this.#rows.get(this.#key(input)) ?? DEFAULT_SENTINEL_USER_SETTINGS);
  }

  async patch(input: PatchSentinelSettingsInput): Promise<SentinelUserSettings> {
    const current = await this.get(input);
    const next: SentinelUserSettings = {
      offline_mode: input.offline_mode ?? current.offline_mode,
      tier2_auto_allow: normalizeTier2AutoAllow(input.tier2_auto_allow ?? current.tier2_auto_allow),
      search_without_asking: input.search_without_asking ?? current.search_without_asking,
      maps_without_asking: input.maps_without_asking ?? current.maps_without_asking,
      sandbox_without_asking: input.sandbox_without_asking ?? current.sandbox_without_asking,
      package_downloads_without_project_allowed:
        input.package_downloads_without_project_allowed ?? current.package_downloads_without_project_allowed,
    };
    this.#rows.set(this.#key(input), next);
    return next;
  }

  #key(owner: SentinelSettingsOwner): string {
    return JSON.stringify([owner.tenant_id, owner.created_by]);
  }
}

/**
 * Global key/value settings shared across tenants (not tenant-scoped). Keys are
 * namespaced by convention (`<domain>_<name>`, e.g. `tool_output_screen_enabled`);
 * values are opaque strings interpreted by the owning domain.
 */

export interface GlobalSettingRecord {
  key: string;
  value: string;
  updated_at: string;
}

export interface GetGlobalSettingInput {
  key: string;
}

export interface SetGlobalSettingInput {
  key: string;
  value: string;
}

/**
 * Durable global settings. `setSetting` upserts by key so a retried write
 * overwrites its own prior row rather than conflicting with it.
 */
export interface IGlobalSettingsStore<TTransaction = never> {
  /** The setting row for a key, or undefined when nothing is stored for it yet. */
  getSetting(input: GetGlobalSettingInput, transaction?: TTransaction): Promise<GlobalSettingRecord | undefined>;
  /** Creates or replaces the setting row for a key; returns the stored row. */
  setSetting(input: SetGlobalSettingInput, transaction?: TTransaction): Promise<GlobalSettingRecord>;
  /** Removes the setting row for a key; a no-op when nothing is stored for it. */
  deleteSetting(input: GetGlobalSettingInput, transaction?: TTransaction): Promise<void>;
  /** Every stored setting row, ordered by key. Backs whole-instance reads such as the data export. */
  listSettings(transaction?: TTransaction): Promise<GlobalSettingRecord[]>;
}

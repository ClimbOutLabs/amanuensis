import type { Kysely } from 'kysely';

import type { Tier2ActionKind } from '@truefoundry/trueforge-core/core';

/** Minimal database shape this store needs. Both SQLite and Postgres provide it. */
export interface SentinelUserSettingsDatabase {
  sentinel_user_settings: {
    tenant_id: string;
    created_by: string;
    tier2_always_ask: string;
    offline_mode: number | boolean;
    updated_at: string | Date;
  };
}

export interface SentinelUserSettings {
  tier2_always_ask: Tier2ActionKind[];
  offline_mode: boolean;
}

export interface GetSentinelUserSettingsInput {
  tenant_id: string;
  created_by: string;
}

export interface UpdateSentinelUserSettingsInput {
  tenant_id: string;
  created_by: string;
  tier2_always_ask?: Tier2ActionKind[];
  offline_mode?: boolean;
}

const DEFAULT_SETTINGS: SentinelUserSettings = {
  tier2_always_ask: [],
  offline_mode: false,
};

function toSettings(row: SentinelUserSettingsDatabase['sentinel_user_settings'] | undefined): SentinelUserSettings {
  if (row === undefined) return { ...DEFAULT_SETTINGS };
  let kinds: Tier2ActionKind[] = [];
  try {
    const parsed: unknown = JSON.parse(row.tier2_always_ask);
    if (Array.isArray(parsed)) {
      kinds = parsed.filter((v): v is Tier2ActionKind => typeof v === 'string');
    }
  } catch {
    kinds = [];
  }
  return {
    tier2_always_ask: kinds,
    offline_mode: row.offline_mode === true || row.offline_mode === 1,
  };
}

/**
 * Durable per-user Sentinel settings. Backs the Tier 2 "always ask" toggles
 * and offline mode in the UI, and feeds the classifier's alwaysAsk/isOffline
 * service readers.
 */
export class SentinelUserSettingsStore {
  readonly #db: Kysely<SentinelUserSettingsDatabase>;

  constructor(db: Kysely<SentinelUserSettingsDatabase>) {
    this.#db = db;
  }

  async get(input: GetSentinelUserSettingsInput): Promise<SentinelUserSettings> {
    const row = await this.#db
      .selectFrom('sentinel_user_settings')
      .selectAll()
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by)
      .executeTakeFirst();
    return toSettings(row);
  }

  async upsert(input: UpdateSentinelUserSettingsInput): Promise<SentinelUserSettings> {
    const current = await this.get(input);
    const next: SentinelUserSettings = {
      tier2_always_ask: input.tier2_always_ask ?? current.tier2_always_ask,
      offline_mode: input.offline_mode ?? current.offline_mode,
    };
    const now = new Date().toISOString();
    await this.#db
      .insertInto('sentinel_user_settings')
      .values({
        tenant_id: input.tenant_id,
        created_by: input.created_by,
        tier2_always_ask: JSON.stringify(next.tier2_always_ask),
        offline_mode: next.offline_mode ? 1 : 0,
        updated_at: now,
      })
      .onConflict(oc =>
        oc.columns(['tenant_id', 'created_by']).doUpdateSet({
          tier2_always_ask: JSON.stringify(next.tier2_always_ask),
          offline_mode: next.offline_mode ? 1 : 0,
          updated_at: now,
        }),
      )
      .execute();
    return next;
  }
}

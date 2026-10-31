import type { Kysely, Transaction } from 'kysely';

import type { SentinelUserSettings } from '../../../schemas/sentinelSettings';
import {
  DEFAULT_SENTINEL_USER_SETTINGS,
  normalizeTier2AutoAllow,
  type ISentinelSettingsStore,
  type PatchSentinelSettingsInput,
  type SentinelSettingsOwner,
} from '../../sentinelSettingsStore';
import { jsonbBind, jsonText, nowIso } from '../sqlExpressions';
import type { Database } from '../types';

export class SqliteSentinelSettingsStore implements ISentinelSettingsStore<Transaction<Database>> {
  readonly #db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.#db = db;
  }

  async get(input: SentinelSettingsOwner, transaction?: Transaction<Database>): Promise<SentinelUserSettings> {
    const db = transaction ?? this.#db;
    const row = await db
      .selectFrom('sentinel_user_settings')
      .select(eb => [
        'offline_mode' as const,
        'search_without_asking' as const,
        'maps_without_asking' as const,
        'sandbox_without_asking' as const,
        'chat_search_enabled' as const,
        jsonText<SentinelUserSettings['tier2_auto_allow']>(eb.ref('tier2_auto_allow')).as('tier2_auto_allow'),
      ])
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by)
      .executeTakeFirst();
    return row === undefined
      ? DEFAULT_SENTINEL_USER_SETTINGS
      : {
          offline_mode: row.offline_mode === 1,
          tier2_auto_allow: normalizeTier2AutoAllow(row.tier2_auto_allow),
          search_without_asking: row.search_without_asking === 1,
          maps_without_asking: row.maps_without_asking === 1,
          sandbox_without_asking: row.sandbox_without_asking === 1,
          chat_search_enabled: row.chat_search_enabled === 1,
        };
  }

  async patch(input: PatchSentinelSettingsInput, transaction?: Transaction<Database>): Promise<SentinelUserSettings> {
    const db = transaction ?? this.#db;
    const timestamp = nowIso();
    const tier2 = input.tier2_auto_allow === undefined ? undefined : normalizeTier2AutoAllow(input.tier2_auto_allow);
    // One upsert statement: fields the caller omitted keep their stored value on conflict.
    await db
      .insertInto('sentinel_user_settings')
      .values({
        tenant_id: input.tenant_id,
        created_by: input.created_by,
        offline_mode: input.offline_mode === true ? 1 : 0,
        tier2_auto_allow: jsonbBind(tier2 ?? []),
        search_without_asking:
          (input.search_without_asking ?? DEFAULT_SENTINEL_USER_SETTINGS.search_without_asking) ? 1 : 0,
        maps_without_asking: (input.maps_without_asking ?? DEFAULT_SENTINEL_USER_SETTINGS.maps_without_asking) ? 1 : 0,
        sandbox_without_asking:
          (input.sandbox_without_asking ?? DEFAULT_SENTINEL_USER_SETTINGS.sandbox_without_asking) ? 1 : 0,
        chat_search_enabled: (input.chat_search_enabled ?? DEFAULT_SENTINEL_USER_SETTINGS.chat_search_enabled) ? 1 : 0,
        created_at: timestamp,
        updated_at: timestamp,
      })
      .onConflict(oc =>
        oc.columns(['tenant_id', 'created_by']).doUpdateSet({
          updated_at: timestamp,
          ...(input.offline_mode === undefined ? {} : { offline_mode: input.offline_mode ? 1 : 0 }),
          ...(tier2 === undefined ? {} : { tier2_auto_allow: jsonbBind(tier2) }),
          ...(input.search_without_asking === undefined
            ? {}
            : { search_without_asking: input.search_without_asking ? 1 : 0 }),
          ...(input.maps_without_asking === undefined
            ? {}
            : { maps_without_asking: input.maps_without_asking ? 1 : 0 }),
          ...(input.chat_search_enabled === undefined
            ? {}
            : { chat_search_enabled: input.chat_search_enabled ? 1 : 0 }),
          ...(input.sandbox_without_asking === undefined
            ? {}
            : { sandbox_without_asking: input.sandbox_without_asking ? 1 : 0 }),
        }),
      )
      .execute();
    return await this.get(input, transaction);
  }
}

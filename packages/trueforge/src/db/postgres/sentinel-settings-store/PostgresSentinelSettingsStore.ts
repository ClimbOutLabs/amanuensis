import type { Kysely, Transaction } from 'kysely';

import type { SentinelUserSettings } from '../../../schemas/sentinelSettings';
import {
  DEFAULT_SENTINEL_USER_SETTINGS,
  normalizeTier2AutoAllow,
  type ISentinelSettingsStore,
  type PatchSentinelSettingsInput,
  type SentinelSettingsOwner,
} from '../../sentinelSettingsStore';
import { json, now } from '../sqlExpressions';
import type { Database } from '../types';

export class PostgresSentinelSettingsStore implements ISentinelSettingsStore<Transaction<Database>> {
  readonly #db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.#db = db;
  }

  async get(input: SentinelSettingsOwner, transaction?: Transaction<Database>): Promise<SentinelUserSettings> {
    const db = transaction ?? this.#db;
    const row = await db
      .selectFrom('sentinel_user_settings')
      .select([
        'offline_mode',
        'tier2_auto_allow',
        'search_without_asking',
        'maps_without_asking',
        'sandbox_without_asking',
        'package_downloads_without_project_allowed',
      ])
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by)
      .executeTakeFirst();
    return row === undefined
      ? DEFAULT_SENTINEL_USER_SETTINGS
      : {
          offline_mode: row.offline_mode,
          tier2_auto_allow: normalizeTier2AutoAllow(row.tier2_auto_allow),
          search_without_asking: row.search_without_asking,
          maps_without_asking: row.maps_without_asking,
          sandbox_without_asking: row.sandbox_without_asking,
          package_downloads_without_project_allowed: row.package_downloads_without_project_allowed,
        };
  }

  async patch(input: PatchSentinelSettingsInput, transaction?: Transaction<Database>): Promise<SentinelUserSettings> {
    const db = transaction ?? this.#db;
    const tier2 = input.tier2_auto_allow === undefined ? undefined : normalizeTier2AutoAllow(input.tier2_auto_allow);
    // One upsert statement: fields the caller omitted keep their stored value on conflict.
    await db
      .insertInto('sentinel_user_settings')
      .values({
        tenant_id: input.tenant_id,
        created_by: input.created_by,
        offline_mode: input.offline_mode ?? false,
        tier2_auto_allow: json(tier2 ?? []),
        search_without_asking: input.search_without_asking ?? DEFAULT_SENTINEL_USER_SETTINGS.search_without_asking,
        maps_without_asking: input.maps_without_asking ?? DEFAULT_SENTINEL_USER_SETTINGS.maps_without_asking,
        sandbox_without_asking: input.sandbox_without_asking ?? DEFAULT_SENTINEL_USER_SETTINGS.sandbox_without_asking,
        package_downloads_without_project_allowed:
          input.package_downloads_without_project_allowed ??
          DEFAULT_SENTINEL_USER_SETTINGS.package_downloads_without_project_allowed,
        created_at: now(),
        updated_at: now(),
      })
      .onConflict(oc =>
        oc.columns(['tenant_id', 'created_by']).doUpdateSet({
          updated_at: now(),
          ...(input.offline_mode === undefined ? {} : { offline_mode: input.offline_mode }),
          ...(tier2 === undefined ? {} : { tier2_auto_allow: json(tier2) }),
          ...(input.search_without_asking === undefined ? {} : { search_without_asking: input.search_without_asking }),
          ...(input.maps_without_asking === undefined ? {} : { maps_without_asking: input.maps_without_asking }),
          ...(input.sandbox_without_asking === undefined
            ? {}
            : { sandbox_without_asking: input.sandbox_without_asking }),
          ...(input.package_downloads_without_project_allowed === undefined
            ? {}
            : {
                package_downloads_without_project_allowed: input.package_downloads_without_project_allowed,
              }),
        }),
      )
      .execute();
    return await this.get(input, transaction);
  }
}

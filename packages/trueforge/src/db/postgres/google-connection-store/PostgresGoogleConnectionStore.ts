import type {
  GoogleConnectionRecord,
  GoogleConnectionVersion,
  GoogleOwner,
  PendingGoogleAuthorization,
} from '@truefoundry/trueforge-core/core/google/connection';
import type { Kysely } from 'kysely';

import {
  type IGoogleConnectionStore,
  PENDING_GOOGLE_AUTHORIZATION_RETENTION_MS,
  splitScopes,
} from '../../googleConnectionStore';
import type { Database } from '../types';

export class PostgresGoogleConnectionStore implements IGoogleConnectionStore {
  readonly #db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.#db = db;
  }

  async get(owner: GoogleOwner): Promise<GoogleConnectionRecord | null> {
    const row = await this.#db
      .selectFrom('google_connection')
      .selectAll()
      .where('tenant_id', '=', owner.tenant_id)
      .where('created_by', '=', owner.created_by)
      .executeTakeFirst();
    return row === undefined
      ? null
      : {
          ...row,
          granted_scopes: splitScopes(row.granted_scopes),
          created_at: row.created_at.toISOString(),
          updated_at: row.updated_at.toISOString(),
        };
  }

  async save(record: GoogleConnectionRecord): Promise<void> {
    const row = {
      ...record,
      granted_scopes: record.granted_scopes.join(' '),
      created_at: new Date(record.created_at),
      updated_at: new Date(record.updated_at),
    };
    await this.#db
      .insertInto('google_connection')
      .values(row)
      .onConflict(oc =>
        oc.columns(['tenant_id', 'created_by']).doUpdateSet({
          client_id: row.client_id,
          client_secret: row.client_secret,
          client_type: row.client_type,
          refresh_token: row.refresh_token,
          granted_scopes: row.granted_scopes,
          account_email: row.account_email,
          status: row.status,
          updated_at: row.updated_at,
        }),
      )
      .execute();
  }

  async markNeedsReconnect(input: { owner: GoogleOwner; expected: GoogleConnectionVersion }): Promise<boolean> {
    const result = await this.#db
      .updateTable('google_connection')
      .set({ status: 'needs_reconnect', updated_at: new Date() })
      .where('tenant_id', '=', input.owner.tenant_id)
      .where('created_by', '=', input.owner.created_by)
      .where('refresh_token', '=', input.expected.refresh_token)
      .where('updated_at', '=', new Date(input.expected.updated_at))
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  async setAccountEmail(input: {
    owner: GoogleOwner;
    expected: GoogleConnectionVersion;
    account_email: string;
    updated_at: string;
  }): Promise<boolean> {
    const result = await this.#db
      .updateTable('google_connection')
      .set({ account_email: input.account_email, updated_at: new Date(input.updated_at) })
      .where('tenant_id', '=', input.owner.tenant_id)
      .where('created_by', '=', input.owner.created_by)
      .where('refresh_token', '=', input.expected.refresh_token)
      .where('updated_at', '=', new Date(input.expected.updated_at))
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  async delete(owner: GoogleOwner): Promise<void> {
    await this.#db
      .deleteFrom('google_connection')
      .where('tenant_id', '=', owner.tenant_id)
      .where('created_by', '=', owner.created_by)
      .execute();
  }

  async savePending(pending: PendingGoogleAuthorization): Promise<void> {
    const row = { ...pending, scopes: pending.scopes.join(' '), created_at: new Date(pending.created_at) };
    await this.purgeExpiredPending();
    await this.#db
      .insertInto('google_oauth_pending')
      .values(row)
      .onConflict(oc =>
        oc.columns(['tenant_id', 'created_by']).doUpdateSet({
          state_hash: row.state_hash,
          pkce_verifier: row.pkce_verifier,
          client_id: row.client_id,
          client_secret: row.client_secret,
          client_type: row.client_type,
          redirect_uri: row.redirect_uri,
          scopes: row.scopes,
          created_at: row.created_at,
        }),
      )
      .execute();
  }

  async purgeExpiredPending(): Promise<void> {
    await this.#db
      .deleteFrom('google_oauth_pending')
      .where('created_at', '<', new Date(Date.now() - PENDING_GOOGLE_AUTHORIZATION_RETENTION_MS))
      .execute();
  }

  async takePending(input: GoogleOwner & { state_hash: string }): Promise<PendingGoogleAuthorization | null> {
    await this.purgeExpiredPending();
    const row = await this.#db
      .deleteFrom('google_oauth_pending')
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by)
      .where('state_hash', '=', input.state_hash)
      .returningAll()
      .executeTakeFirst();
    return row === undefined
      ? null
      : { ...row, scopes: splitScopes(row.scopes), created_at: row.created_at.toISOString() };
  }

  async hasPending(owner: GoogleOwner): Promise<boolean> {
    await this.purgeExpiredPending();
    const row = await this.#db
      .selectFrom('google_oauth_pending')
      .select('created_by')
      .where('tenant_id', '=', owner.tenant_id)
      .where('created_by', '=', owner.created_by)
      .executeTakeFirst();
    return row !== undefined;
  }

  async clearPending(owner: GoogleOwner): Promise<void> {
    await this.#db
      .deleteFrom('google_oauth_pending')
      .where('tenant_id', '=', owner.tenant_id)
      .where('created_by', '=', owner.created_by)
      .execute();
  }
}

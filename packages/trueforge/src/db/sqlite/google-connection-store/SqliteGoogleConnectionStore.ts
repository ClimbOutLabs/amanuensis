import type {
  GoogleConnectionRecord,
  GoogleOwner,
  PendingGoogleAuthorization,
} from '@truefoundry/trueforge-core/core/google/connection';
import type { Kysely } from 'kysely';

import {
  type IGoogleConnectionStore,
  PENDING_GOOGLE_AUTHORIZATION_RETENTION_MS,
  splitScopes,
} from '../../googleConnectionStore';
import { nowIso } from '../sqlExpressions';
import type { Database } from '../types';

export class SqliteGoogleConnectionStore implements IGoogleConnectionStore {
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
    return row === undefined ? null : { ...row, granted_scopes: splitScopes(row.granted_scopes) };
  }

  async save(record: GoogleConnectionRecord): Promise<void> {
    const row = { ...record, granted_scopes: record.granted_scopes.join(' ') };
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

  async markNeedsReconnect(owner: GoogleOwner): Promise<void> {
    await this.#db
      .updateTable('google_connection')
      .set({ status: 'needs_reconnect', updated_at: nowIso() })
      .where('tenant_id', '=', owner.tenant_id)
      .where('created_by', '=', owner.created_by)
      .execute();
  }

  async delete(owner: GoogleOwner): Promise<void> {
    await this.#db
      .deleteFrom('google_connection')
      .where('tenant_id', '=', owner.tenant_id)
      .where('created_by', '=', owner.created_by)
      .execute();
  }

  async savePending(pending: PendingGoogleAuthorization): Promise<void> {
    const row = { ...pending, scopes: pending.scopes.join(' ') };
    const cutoff = new Date(Date.now() - PENDING_GOOGLE_AUTHORIZATION_RETENTION_MS).toISOString();
    await this.#db.deleteFrom('google_oauth_pending').where('created_at', '<', cutoff).execute();
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

  async takePending(input: GoogleOwner & { state_hash: string }): Promise<PendingGoogleAuthorization | null> {
    const row = await this.#db
      .deleteFrom('google_oauth_pending')
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by)
      .where('state_hash', '=', input.state_hash)
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? null : { ...row, scopes: splitScopes(row.scopes) };
  }

  async hasPending(owner: GoogleOwner): Promise<boolean> {
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

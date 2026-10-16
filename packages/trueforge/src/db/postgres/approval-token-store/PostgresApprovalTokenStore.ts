import {
  hasApprovalScope,
  hashApprovalTokenId,
  prepareApprovalToken,
  restoreApprovalToken,
  type ApprovalToken,
  type ApprovalTokenRef,
  type ApprovalTokenStore,
  type MintApprovalTokenInput,
} from '@truefoundry/trueforge-core/core';
import type { Kysely } from 'kysely';

import { json, now } from '../sqlExpressions';
import type { Database } from '../types';

/**
 * Approval tokens in Postgres, shared by every replica. Redeem is one UPDATE ... RETURNING guarded
 * by `used_at IS NULL`: concurrent redeems serialize on the row lock and only one sees it unused.
 * Expiry is judged by the database clock.
 */
export class PostgresApprovalTokenStore implements ApprovalTokenStore {
  readonly #db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.#db = db;
  }

  async mint(input: MintApprovalTokenInput): Promise<ApprovalToken> {
    const { token, token_hash, expires_at } = prepareApprovalToken(input);
    await this.#db
      .deleteFrom('approval_token')
      .where(eb => eb.or([eb('used_at', 'is not', null), eb('expires_at', '<=', now())]))
      .execute();
    await this.#db
      .insertInto('approval_token')
      .values({
        token_hash,
        action_id: token.action_id,
        params_hash: token.params_hash,
        shell_binding: token.shell === null ? null : json(token.shell),
        tenant_id: input.tenant_id,
        created_by: input.created_by,
        created_at: new Date(token.created_at),
        expires_at: new Date(expires_at),
        used_at: null,
      })
      .execute();
    return token;
  }

  async peek(input: ApprovalTokenRef): Promise<ApprovalToken | undefined> {
    if (!hasApprovalScope(input)) {
      return undefined;
    }
    const row = await this.#db
      .selectFrom('approval_token')
      .select(['action_id', 'params_hash', 'created_at', 'shell_binding'])
      .where('token_hash', '=', hashApprovalTokenId(input.token_id))
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by)
      .where('used_at', 'is', null)
      .where('expires_at', '>', now())
      .executeTakeFirst();
    return row === undefined
      ? undefined
      : restoreApprovalToken({
          token_id: input.token_id,
          action_id: row.action_id,
          params_hash: row.params_hash,
          shell: row.shell_binding,
          created_at: row.created_at.toISOString(),
        });
  }

  async redeem(input: ApprovalTokenRef): Promise<ApprovalToken | undefined> {
    if (!hasApprovalScope(input)) {
      return undefined;
    }
    const row = await this.#db
      .updateTable('approval_token')
      .set({ used_at: now() })
      .where('token_hash', '=', hashApprovalTokenId(input.token_id))
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by)
      .where('used_at', 'is', null)
      .where('expires_at', '>', now())
      .returning(['action_id', 'params_hash', 'created_at', 'shell_binding'])
      .executeTakeFirst();
    return row === undefined
      ? undefined
      : restoreApprovalToken({
          token_id: input.token_id,
          action_id: row.action_id,
          params_hash: row.params_hash,
          shell: row.shell_binding,
          created_at: row.created_at.toISOString(),
        });
  }
}

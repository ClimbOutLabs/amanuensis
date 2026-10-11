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

import { jsonbBind, jsonText, nowIso } from '../sqlExpressions';
import type { Database } from '../types';

/**
 * Approval tokens in SQLite. Redeem is one UPDATE ... RETURNING, so it is atomic across connections
 * and processes sharing the file, and every call reads the database.
 */
export class SqliteApprovalTokenStore implements ApprovalTokenStore {
  readonly #db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.#db = db;
  }

  async mint(input: MintApprovalTokenInput): Promise<ApprovalToken> {
    const { token, token_hash, expires_at } = prepareApprovalToken(input);
    await this.#db
      .deleteFrom('approval_token')
      .where(eb => eb.or([eb('used_at', 'is not', null), eb('expires_at', '<=', nowIso())]))
      .execute();
    await this.#db
      .insertInto('approval_token')
      .values({
        token_hash,
        action_id: token.action_id,
        params_hash: token.params_hash,
        shell_binding: token.shell === null ? null : jsonbBind(token.shell),
        tenant_id: input.tenant_id,
        created_by: input.created_by,
        created_at: token.created_at,
        expires_at,
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
      .select(eb => [
        'action_id',
        'params_hash',
        'created_at',
        jsonText<unknown>(eb.ref('shell_binding')).as('shell_binding'),
      ])
      .where('token_hash', '=', hashApprovalTokenId(input.token_id))
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by)
      .where('used_at', 'is', null)
      .where('expires_at', '>', nowIso())
      .executeTakeFirst();
    return row === undefined
      ? undefined
      : restoreApprovalToken({ ...row, token_id: input.token_id, shell: row.shell_binding });
  }

  async redeem(input: ApprovalTokenRef): Promise<ApprovalToken | undefined> {
    if (!hasApprovalScope(input)) {
      return undefined;
    }
    const now = nowIso();
    const row = await this.#db
      .updateTable('approval_token')
      .set({ used_at: now })
      .where('token_hash', '=', hashApprovalTokenId(input.token_id))
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by)
      .where('used_at', 'is', null)
      .where('expires_at', '>', now)
      .returning(eb => [
        'action_id',
        'params_hash',
        'created_at',
        jsonText<unknown>(eb.ref('shell_binding')).as('shell_binding'),
      ])
      .executeTakeFirst();
    return row === undefined
      ? undefined
      : restoreApprovalToken({ ...row, token_id: input.token_id, shell: row.shell_binding });
  }
}

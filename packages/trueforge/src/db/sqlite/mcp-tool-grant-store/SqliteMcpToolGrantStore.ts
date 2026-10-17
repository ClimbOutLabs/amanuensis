import type { ToolGrantKey } from '@truefoundry/trueforge-core/core';
import type { Kysely, Transaction } from 'kysely';

import type { McpToolGrant } from '../../../schemas/mcpServer';
import type {
  IMcpToolGrantStore,
  ListMcpToolGrantsInput,
  RevokeServerToolGrantsInput,
  RevokeToolGrantInput,
} from '../../mcpToolGrantStore';
import { nowIso } from '../sqlExpressions';
import type { Database } from '../types';

export class SqliteMcpToolGrantStore implements IMcpToolGrantStore<Transaction<Database>> {
  readonly #db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.#db = db;
  }

  async hasToolGrant(key: ToolGrantKey): Promise<boolean> {
    const scope = {
      tenant_id: key.tenant_id,
      created_by: key.created_by,
      mcp_server_name: key.mcp_server_name,
      tool_name: key.tool_name,
    };
    const row = await this.#db
      .selectFrom('mcp_tool_grant')
      .select('connector_fingerprint')
      .where('tenant_id', '=', scope.tenant_id)
      .where('created_by', '=', scope.created_by)
      .where('mcp_server_name', '=', scope.mcp_server_name)
      .where('tool_name', '=', scope.tool_name)
      .where(eb =>
        eb.or([
          eb.and([
            eb('mcp_server_id', '=', key.connector.id),
            eb('connector_fingerprint', '=', key.connector.fingerprint),
          ]),
          eb('connector_fingerprint', '=', ''),
        ]),
      )
      .executeTakeFirst();
    if (row === undefined) {
      return false;
    }
    if (row.connector_fingerprint === '') {
      await this.#db
        .updateTable('mcp_tool_grant')
        .set({ mcp_server_id: key.connector.id, connector_fingerprint: key.connector.fingerprint })
        .where('tenant_id', '=', scope.tenant_id)
        .where('created_by', '=', scope.created_by)
        .where('mcp_server_name', '=', scope.mcp_server_name)
        .where('tool_name', '=', scope.tool_name)
        .where('connector_fingerprint', '=', '')
        .execute();
    }
    return true;
  }

  async recordToolGrant(key: ToolGrantKey): Promise<void> {
    const { connector, ...scope } = key;
    await this.#db
      .insertInto('mcp_tool_grant')
      .values({
        ...scope,
        mcp_server_id: connector.id,
        connector_fingerprint: connector.fingerprint,
        created_at: nowIso(),
      })
      .onConflict(oc =>
        oc
          .columns(['tenant_id', 'created_by', 'mcp_server_name', 'tool_name'])
          .doUpdateSet({
            mcp_server_id: connector.id,
            connector_fingerprint: connector.fingerprint,
            created_at: nowIso(),
          })
          .where(eb =>
            eb.or([
              eb('mcp_tool_grant.mcp_server_id', '!=', connector.id),
              eb('mcp_tool_grant.connector_fingerprint', '!=', connector.fingerprint),
            ]),
          ),
      )
      .execute();
  }

  async listToolGrants(input: ListMcpToolGrantsInput): Promise<McpToolGrant[]> {
    return await this.#db
      .selectFrom('mcp_tool_grant')
      .select(['tool_name', 'created_at'])
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by)
      .where('mcp_server_name', '=', input.mcp_server_name)
      .where(eb =>
        eb.or([
          eb.and([
            eb('mcp_server_id', '=', input.connector.id),
            eb('connector_fingerprint', '=', input.connector.fingerprint),
          ]),
          eb('connector_fingerprint', '=', ''),
        ]),
      )
      .orderBy('created_at', 'asc')
      .orderBy('tool_name', 'asc')
      .execute();
  }

  async revokeToolGrant(key: RevokeToolGrantInput): Promise<void> {
    await this.#db
      .deleteFrom('mcp_tool_grant')
      .where('tenant_id', '=', key.tenant_id)
      .where('created_by', '=', key.created_by)
      .where('mcp_server_name', '=', key.mcp_server_name)
      .where('tool_name', '=', key.tool_name)
      .execute();
  }

  async revokeServerToolGrants(input: RevokeServerToolGrantsInput, transaction?: Transaction<Database>): Promise<void> {
    await (transaction ?? this.#db)
      .deleteFrom('mcp_tool_grant')
      .where('tenant_id', '=', input.tenant_id)
      .where('mcp_server_name', '=', input.mcp_server_name)
      .execute();
  }
}

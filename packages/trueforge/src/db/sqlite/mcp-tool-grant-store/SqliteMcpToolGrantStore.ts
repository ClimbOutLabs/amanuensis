import type { ToolGrantKey } from '@truefoundry/trueforge-core/core';
import type { Kysely, Transaction } from 'kysely';

import type { McpToolGrant } from '../../../schemas/mcpServer';
import type { IMcpToolGrantStore, ListMcpToolGrantsInput, RevokeServerToolGrantsInput } from '../../mcpToolGrantStore';
import { nowIso } from '../sqlExpressions';
import type { Database } from '../types';

export class SqliteMcpToolGrantStore implements IMcpToolGrantStore<Transaction<Database>> {
  readonly #db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.#db = db;
  }

  async hasToolGrant(key: ToolGrantKey): Promise<boolean> {
    const row = await this.#db
      .selectFrom('mcp_tool_grant')
      .select('tool_name')
      .where('tenant_id', '=', key.tenant_id)
      .where('created_by', '=', key.created_by)
      .where('mcp_server_name', '=', key.mcp_server_name)
      .where('tool_name', '=', key.tool_name)
      .executeTakeFirst();
    return row !== undefined;
  }

  async recordToolGrant(key: ToolGrantKey): Promise<void> {
    await this.#db
      .insertInto('mcp_tool_grant')
      .values({ ...key, created_at: nowIso() })
      .onConflict(oc => oc.columns(['tenant_id', 'created_by', 'mcp_server_name', 'tool_name']).doNothing())
      .execute();
  }

  async listToolGrants(input: ListMcpToolGrantsInput): Promise<McpToolGrant[]> {
    return await this.#db
      .selectFrom('mcp_tool_grant')
      .select(['tool_name', 'created_at'])
      .where('tenant_id', '=', input.tenant_id)
      .where('created_by', '=', input.created_by)
      .where('mcp_server_name', '=', input.mcp_server_name)
      .orderBy('created_at', 'asc')
      .orderBy('tool_name', 'asc')
      .execute();
  }

  async revokeToolGrant(key: ToolGrantKey): Promise<void> {
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

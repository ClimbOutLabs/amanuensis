import type { ConnectorIdentity, ToolGrantStore } from '@truefoundry/trueforge-core/core';

import type { McpToolGrant } from '../schemas/mcpServer';

export interface ListMcpToolGrantsInput {
  tenant_id: string;
  created_by: string;
  mcp_server_name: string;
  /** The connector as configured now; grants chosen under another configuration are not listed. */
  connector: ConnectorIdentity;
}

export interface RevokeToolGrantInput {
  tenant_id: string;
  created_by: string;
  mcp_server_name: string;
  tool_name: string;
}

export interface RevokeServerToolGrantsInput {
  tenant_id: string;
  mcp_server_name: string;
}

/**
 * Durable "Always allow this tool" grants: one row per user, connector, and tool, valid only for the
 * connector id and configuration digest recorded with it. The Sentinel classifier reads them through
 * the core `ToolGrantStore` half of this contract. A row from before connector identity was recorded
 * adopts the connector's identity the first time it is used.
 */
export interface IMcpToolGrantStore<TTransaction = never> extends ToolGrantStore {
  /** The user's grants on one connector, oldest first. */
  listToolGrants(input: ListMcpToolGrantsInput): Promise<McpToolGrant[]>;
  /** Removes one grant; a no-op when none exists. */
  revokeToolGrant(input: RevokeToolGrantInput): Promise<void>;
  /** Removes every user's grants on one connector. */
  revokeServerToolGrants(input: RevokeServerToolGrantsInput, transaction?: TTransaction): Promise<void>;
}

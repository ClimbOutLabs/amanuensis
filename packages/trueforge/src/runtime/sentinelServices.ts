import {
  DEFAULT_PINNED_PATH,
  defaultSentinelServices,
  type ApprovalTokenStore,
  type AuditLogWriter,
  type OutboundEventWriter,
  type SentinelServices,
  type ToolGrantStore,
} from '@truefoundry/trueforge-core/core';
import type { ISentinelSettingsStore } from '../db/sentinelSettingsStore';
import { sentinelSettingsServices } from './sentinelSettingsServices';

/**
 * Server Sentinel services over durable stores; the approval token and tool grant stores are
 * required so neither falls back to memory.
 */
export function createSentinelServices(stores: {
  audit: AuditLogWriter;
  outbound: OutboundEventWriter;
  settings: ISentinelSettingsStore;
  approvalTokens: ApprovalTokenStore;
  toolGrants: ToolGrantStore;
  /** Exact secret values the server holds, for the outbound secret guard. */
  outboundSecrets: SentinelServices['outboundSecrets'];
}): SentinelServices {
  return {
    ...defaultSentinelServices({ pinned_path: DEFAULT_PINNED_PATH }),
    audit: stores.audit,
    outbound: stores.outbound,
    token_store: stores.approvalTokens,
    tool_grants: stores.toolGrants,
    outboundSecrets: stores.outboundSecrets,
    ...sentinelSettingsServices(stores.settings),
  };
}

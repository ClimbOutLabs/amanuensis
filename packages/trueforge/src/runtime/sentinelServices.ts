import {
  DEFAULT_PINNED_PATH,
  defaultSentinelServices,
  type ApprovalTokenStore,
  type AuditLogWriter,
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
  settings: ISentinelSettingsStore;
  approvalTokens: ApprovalTokenStore;
  toolGrants: ToolGrantStore;
  /** Exact secret values the server holds, for the outbound secret guard. */
  outboundSecrets: SentinelServices['outboundSecrets'];
  /** Whether this instance is a demo; only then is mail limited to the send list. */
  demoMode: boolean;
  /** The only addresses a demo instance may send mail to. */
  demoSendAllowlist: readonly string[];
}): SentinelServices {
  return {
    ...defaultSentinelServices({ pinned_path: DEFAULT_PINNED_PATH }),
    audit: stores.audit,
    token_store: stores.approvalTokens,
    tool_grants: stores.toolGrants,
    outboundSecrets: stores.outboundSecrets,
    demoSendAllowlist: stores.demoMode ? stores.demoSendAllowlist : null,
    ...sentinelSettingsServices(stores.settings),
  };
}

import {
  DEFAULT_PINNED_PATH,
  defaultSentinelServices,
  type ApprovalTokenStore,
  type AuditLogWriter,
  type SentinelServices,
} from '@truefoundry/trueforge-core/core';
import type { ISentinelSettingsStore } from '../db/sentinelSettingsStore';
import { sentinelSettingsServices } from './sentinelSettingsServices';

/** Server Sentinel services over durable stores; the approval token store is required so none falls back to memory. */
export function createSentinelServices(stores: {
  audit: AuditLogWriter;
  settings: ISentinelSettingsStore;
  approvalTokens: ApprovalTokenStore;
}): SentinelServices {
  return {
    ...defaultSentinelServices({ pinned_path: DEFAULT_PINNED_PATH }),
    audit: stores.audit,
    token_store: stores.approvalTokens,
    ...sentinelSettingsServices(stores.settings),
  };
}

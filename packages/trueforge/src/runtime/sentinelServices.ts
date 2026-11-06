import {
  DEFAULT_PINNED_PATH,
  defaultSentinelServices,
  type ApprovalTokenStore,
  type AuditLogWriter,
  type SentinelServices,
  type ToolGrantStore,
} from '@truefoundry/trueforge-core/core';
import type { ISentinelSettingsStore } from '../db/sentinelSettingsStore';
import type { ISkillStore } from '../db/skillStore';
import { recordSkillNetworkAnswer } from '../sandbox/skillnet/skillNetworkGrant';
import { skillNetworkTokens } from '../sandbox/skillnet/skillNetworkTokens';
import {
  addAllowedRecipients,
  readAllowedRecipientsFile,
  SIDECAR_LOAD_TIMEOUT_MS,
  waitForCurrentSidecarList,
  waitForSidecarLoadedHash,
} from './mailAllowedRecipients';
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
  /** The Email send list the server writes; unset when no sidecar is configured, so nothing is listed. */
  mailPolicyPath: string | undefined;
  /** Where the sidecar records the list it loaded; the server waits on it after a change. */
  mailPolicyStatusPath: string | undefined;
  /** The skill store answers to skill network cards are recorded against; unset records nothing. */
  skillStore?: ISkillStore | undefined;
  /** How long to wait for the sidecar to load a list; defaults to a full sidecar restart. */
  mailPolicyLoadTimeoutMs?: number;
}): SentinelServices {
  const loadTimeoutMs = stores.mailPolicyLoadTimeoutMs ?? SIDECAR_LOAD_TIMEOUT_MS;
  return {
    ...defaultSentinelServices({ pinned_path: DEFAULT_PINNED_PATH }),
    audit: stores.audit,
    token_store: stores.approvalTokens,
    tool_grants: stores.toolGrants,
    outboundSecrets: stores.outboundSecrets,
    demoSendAllowlist: stores.demoMode ? stores.demoSendAllowlist : null,
    mail_listed_addresses: () =>
      stores.mailPolicyPath === undefined
        ? Promise.resolve([])
        : readAllowedRecipientsFile({ path: stores.mailPolicyPath }),
    mail_add_recipients: async (_input, addresses) => {
      const { mailPolicyPath, mailPolicyStatusPath } = stores;
      if (mailPolicyPath === undefined || mailPolicyStatusPath === undefined) {
        return 'refused';
      }
      let hash: string;
      try {
        hash = await addAllowedRecipients({ path: mailPolicyPath, addresses: [...addresses] });
      } catch {
        return 'refused';
      }
      return (await waitForSidecarLoadedHash({ statusPath: mailPolicyStatusPath, hash, timeoutMs: loadTimeoutMs }))
        ? 'loaded'
        : 'not_loaded';
    },
    mail_list_loaded: async () => {
      const { mailPolicyPath, mailPolicyStatusPath } = stores;
      if (mailPolicyPath === undefined || mailPolicyStatusPath === undefined) {
        return 'not_loaded';
      }
      return (await waitForCurrentSidecarList({
        path: mailPolicyPath,
        statusPath: mailPolicyStatusPath,
        timeoutMs: loadTimeoutMs,
      }))
        ? 'loaded'
        : 'not_loaded';
    },
    skill_network_record_answer: async input => {
      if (stores.skillStore === undefined) {
        return;
      }
      await recordSkillNetworkAnswer({
        store: stores.skillStore,
        registry: skillNetworkTokens,
        tenant_id: input.tenant_id,
        created_by: input.created_by,
        session_id: input.session_id,
        skill_name: input.skill_network.skill_name,
        hosts: input.skill_network.hosts,
        reason: input.skill_network.reason,
        answer: input.answer,
      });
    },
    ...sentinelSettingsServices(stores.settings),
  };
}

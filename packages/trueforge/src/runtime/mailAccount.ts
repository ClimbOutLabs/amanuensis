/**
 * The Settings Email card's kind: what differs from the Calendar card. The client, the failures and the
 * registration step are shared (see connectorAccount.ts); this file holds the mail account's shape, its
 * plain lines, and how a save request is resolved against the presets.
 */
import type { PublicMailAccount } from '@truefoundry/trueforge-core/core/email/mailConnector/accountFile';
import {
  cleanMailPassword,
  emailProviderPreset,
  isMicrosoftMailAddress,
  mailAddressProblem,
  mailHostProblem,
  mailModeForCustomPort,
  mailPasswordProblem,
  mailPortProblem,
  MICROSOFT_MAIL_MESSAGE,
} from '@truefoundry/trueforge-core/core/email/mailConnector/presets';
import type { Logger } from 'winston';
import type { IMcpServerStore } from '../db/mcpServerStore';
import {
  ConnectorAccountError,
  createConnectorAccountClient,
  keepConnectorInStepInBackground,
  syncConnectorRegistration,
  type BackoffPlan,
  type ConnectorAccountClientDeps,
  type ConnectorAccountKind,
  type ConnectorAccountState,
} from './connectorAccount';
import { agentErrorKind, agentField } from './connectorAccountAgent';
import { prepareMailPolicyAtBoot, registerMailConnector, unregisterMailConnector } from './mailConnector';

export const MAIL_SIGN_IN_REFUSED_MESSAGE = 'That password was refused. Make a new app password and try again.';
export const MAIL_SERVER_UNREACHABLE_MESSAGE = "Couldn't reach that mail server. Check the server name and port.";
export const MAIL_CONNECTOR_UNREACHABLE_MESSAGE = "Couldn't reach the email connector. Try again.";
export const MAIL_STATUS_UNREACHABLE_MESSAGE = "Couldn't check your email account just now. Try again.";

/** The saved account's state as the card shows it; the password is never part of it. */
export type MailAccountState = ConnectorAccountState<PublicMailAccount>;

/** What the person asked to save, before presets and cleaning resolve it. */
export interface MailAccountSaveRequest {
  provider_key: string;
  address: string;
  password: string;
  imap_host: string | undefined;
  imap_port: number | undefined;
  smtp_host: string | undefined;
  smtp_port: number | undefined;
}

/** The agent's public account view, as parsed from its response; unknown shapes parse to null. */
function parseAgentAccount(body: unknown): PublicMailAccount | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const address = agentField(body, 'address');
  const imapHost = agentField(body, 'imap_host');
  const imapPort = agentField(body, 'imap_port');
  const imapMode = agentField(body, 'imap_mode');
  const smtpHost = agentField(body, 'smtp_host');
  const smtpPort = agentField(body, 'smtp_port');
  const smtpMode = agentField(body, 'smtp_mode');
  if (
    typeof address !== 'string' ||
    typeof imapHost !== 'string' ||
    typeof imapPort !== 'number' ||
    (imapMode !== 'ssl' && imapMode !== 'starttls') ||
    typeof smtpHost !== 'string' ||
    typeof smtpPort !== 'number' ||
    (smtpMode !== 'ssl' && smtpMode !== 'starttls')
  ) {
    return null;
  }
  return {
    address,
    imap_host: imapHost,
    imap_port: imapPort,
    imap_mode: imapMode,
    smtp_host: smtpHost,
    smtp_port: smtpPort,
    smtp_mode: smtpMode,
  };
}

const mailKind: ConnectorAccountKind<PublicMailAccount> = {
  label: 'Email',
  parseAccount: parseAgentAccount,
  connectorUnreachableMessage: MAIL_CONNECTOR_UNREACHABLE_MESSAGE,
  statusUnreachableMessage: MAIL_STATUS_UNREACHABLE_MESSAGE,
  saveRefusal: body => {
    const kind = agentErrorKind(body);
    if (kind === 'sign_in_refused') {
      return { failure: 'sign_in_refused', message: MAIL_SIGN_IN_REFUSED_MESSAGE };
    }
    if (kind === 'server_unreachable') {
      return { failure: 'server_unreachable', message: MAIL_SERVER_UNREACHABLE_MESSAGE };
    }
    return null;
  },
};

const mailClient = createConnectorAccountClient(mailKind);

/** The saved account's state, asking the agent (which re-checks a stale sign-in answer). */
export function getMailAccountState(
  deps: ConnectorAccountClientDeps,
  options?: { timeoutMs?: number | undefined },
): Promise<MailAccountState> {
  return mailClient.getState(deps, options);
}

/**
 * Resolves a save request against the presets and the installer's own rules, in plain words.
 * Returns the exact payload for the agent: the cleaned password and the resolved servers.
 */
export function resolveMailAccountSave(
  request: MailAccountSaveRequest,
): { ok: true; payload: Record<string, unknown> } | { ok: false; message: string } {
  const addressProblem = mailAddressProblem(request.address);
  if (addressProblem !== null) {
    return { ok: false, message: addressProblem };
  }
  if (isMicrosoftMailAddress(request.address)) {
    return { ok: false, message: MICROSOFT_MAIL_MESSAGE };
  }
  const password = cleanMailPassword({ provider_key: request.provider_key, password: request.password });
  const passwordProblem = mailPasswordProblem(password);
  if (passwordProblem !== null) {
    return { ok: false, message: passwordProblem };
  }
  const preset = request.provider_key === 'other' ? undefined : emailProviderPreset(request.provider_key);
  if (request.provider_key !== 'other' && preset === undefined) {
    return { ok: false, message: 'That email provider is not on the list. Pick one and try again.' };
  }
  if (preset !== undefined) {
    return {
      ok: true,
      payload: {
        provider_key: preset.key,
        address: request.address,
        password,
        imap_host: preset.imap_host,
        imap_port: preset.imap_port,
        imap_mode: preset.imap_mode,
        smtp_host: preset.smtp_host,
        smtp_port: preset.smtp_port,
        smtp_mode: preset.smtp_mode,
      },
    };
  }
  const { imap_host: imapHost, imap_port: imapPort, smtp_host: smtpHost, smtp_port: smtpPort } = request;
  if (imapHost === undefined || smtpHost === undefined || imapPort === undefined || smtpPort === undefined) {
    return { ok: false, message: 'Enter both server names and both ports, then try again.' };
  }
  const hostProblem = mailHostProblem(imapHost) ?? mailHostProblem(smtpHost);
  if (hostProblem !== null) {
    return { ok: false, message: hostProblem };
  }
  const portProblem = mailPortProblem(imapPort) ?? mailPortProblem(smtpPort);
  if (portProblem !== null) {
    return { ok: false, message: portProblem };
  }
  return {
    ok: true,
    payload: {
      provider_key: 'other',
      address: request.address,
      password,
      imap_host: imapHost,
      imap_port: imapPort,
      imap_mode: mailModeForCustomPort('imap', imapPort),
      smtp_host: smtpHost,
      smtp_port: smtpPort,
      smtp_mode: mailModeForCustomPort('smtp', smtpPort),
    },
  };
}

/** Saves the account through the agent, which checks the sign-in before storing anything. */
export async function saveMailAccount(
  deps: ConnectorAccountClientDeps,
  request: MailAccountSaveRequest,
): Promise<MailAccountState> {
  const resolved = resolveMailAccountSave(request);
  if (!resolved.ok) {
    throw new ConnectorAccountError({ failure: 'invalid_request', message: resolved.message });
  }
  return mailClient.save(deps, resolved.payload);
}

/** Removes the saved account through the agent; the password is deleted from the account file. */
export function removeMailAccount(deps: ConnectorAccountClientDeps): Promise<MailAccountState> {
  return mailClient.remove(deps);
}

/** Registers the Email connector (with its send list prepared) or removes it, as the saved account says. */
export function syncMailConnectorWithAccount(deps: {
  state: MailAccountState;
  mcpUrl: string | undefined;
  policyPath: string | undefined;
  mcpServerStore: Pick<IMcpServerStore, 'upsertServer' | 'deleteServer'>;
  tenant_id: string;
  logger: Logger;
}): Promise<void> {
  return syncConnectorRegistration({
    state: deps.state,
    label: 'Email',
    logger: deps.logger,
    registration: {
      register: async () => {
        if (deps.mcpUrl === undefined) {
          return;
        }
        await registerMailConnector({
          url: deps.mcpUrl,
          mcpServerStore: deps.mcpServerStore,
          tenant_id: deps.tenant_id,
        });
        await prepareMailPolicyAtBoot({ url: deps.mcpUrl, policyPath: deps.policyPath, logger: deps.logger });
      },
      unregister: () => unregisterMailConnector({ mcpServerStore: deps.mcpServerStore, tenant_id: deps.tenant_id }),
    },
  });
}

/**
 * Boot step for an instance the installer never linked (no MCP endpoint in the configuration): keeps the
 * Email connector in line with the saved account, retrying while the account agent is unreachable.
 */
export function registerMailConnectorFromSavedAccountInBackground(deps: {
  accountUrl: string | undefined;
  mcpUrl: string | undefined;
  policyPath: string | undefined;
  fetchImpl: typeof fetch | undefined;
  mcpServerStore: Pick<IMcpServerStore, 'upsertServer' | 'deleteServer'>;
  tenant_id: string;
  logger: Logger;
  backoff?: BackoffPlan | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
}): void {
  if (deps.accountUrl === undefined || deps.mcpUrl === undefined) {
    return;
  }
  const clientDeps = { accountUrl: deps.accountUrl, fetchImpl: deps.fetchImpl, logger: deps.logger };
  void keepConnectorInStepInBackground({
    readState: () => getMailAccountState(clientDeps),
    apply: state =>
      syncMailConnectorWithAccount({
        state,
        mcpUrl: deps.mcpUrl,
        policyPath: deps.policyPath,
        mcpServerStore: deps.mcpServerStore,
        tenant_id: deps.tenant_id,
        logger: deps.logger,
      }),
    logger: deps.logger,
    label: 'Email',
    backoff: deps.backoff,
    sleep: deps.sleep,
  });
}

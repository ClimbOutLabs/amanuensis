/**
 * The Settings Email card's server side: talks to the mail sidecar's account agent over the
 * instance's private network, and nowhere else. The app password arrives from the Settings form,
 * is cleaned and checked here, and is passed to the agent in one request body. It is never
 * stored by the app, never logged, and never sent back: every response is built from the
 * agent's public account view, which has no password field, and every failure is one of the
 * fixed plain messages below. The agent's own response text is never forwarded or logged,
 * because a mail server's error can echo credentials.
 */
import { extractErrorLogFields } from '@truefoundry/trueforge-core/core';
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
import { prepareMailPolicyAtBoot, registerMailConnector, unregisterMailConnector } from './mailConnector';

export const MAIL_SIGN_IN_REFUSED_MESSAGE = 'That password was refused. Make a new app password and try again.';
export const MAIL_SERVER_UNREACHABLE_MESSAGE = "Couldn't reach that mail server. Check the server name and port.";
export const MAIL_CONNECTOR_UNREACHABLE_MESSAGE = "Couldn't reach the email connector. Try again.";
export const MAIL_STATUS_UNREACHABLE_MESSAGE = "Couldn't check your email account just now. Try again.";

export type MailAccountFailure = 'sign_in_refused' | 'server_unreachable' | 'connector_unreachable' | 'invalid_request';

/** A save or status failure with a fixed plain message; the message is the whole contract. */
export class MailAccountError extends Error {
  readonly failure: MailAccountFailure;
  constructor(failure: MailAccountFailure, message: string) {
    super(message);
    this.name = 'MailAccountError';
    this.failure = failure;
  }
}

/** The saved account's state as the card shows it; the password is never part of it. */
export interface MailAccountState {
  connected: boolean;
  /** The last sign-in check's answer for the saved account; null when no account is saved. */
  sign_in: 'ok' | 'refused' | 'unreachable' | null;
  account: PublicMailAccount | null;
}

export interface MailAccountClientDeps {
  /** The account agent's base address from configuration; undefined means the card is not offered. */
  accountUrl: string | undefined;
  /** Replaceable so tests never reach a real sidecar. */
  fetchImpl: typeof fetch | undefined;
  logger: Pick<Logger, 'warn'>;
}

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
  const fields = new Map(Object.entries(body));
  const address = fields.get('address');
  const imapHost = fields.get('imap_host');
  const imapPort = fields.get('imap_port');
  const imapMode = fields.get('imap_mode');
  const smtpHost = fields.get('smtp_host');
  const smtpPort = fields.get('smtp_port');
  const smtpMode = fields.get('smtp_mode');
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

function stateFromAgentBody(body: unknown): MailAccountState {
  if (typeof body !== 'object' || body === null) {
    throw new MailAccountError('connector_unreachable', MAIL_CONNECTOR_UNREACHABLE_MESSAGE);
  }
  const connected = new Map(Object.entries(body)).get('connected');
  if (connected !== true) {
    return { connected: false, sign_in: null, account: null };
  }
  const account = parseAgentAccount(body);
  if (account === null) {
    throw new MailAccountError('connector_unreachable', MAIL_CONNECTOR_UNREACHABLE_MESSAGE);
  }
  const signIn = new Map(Object.entries(body)).get('sign_in');
  return {
    connected: true,
    sign_in: signIn === 'refused' ? 'refused' : signIn === 'unreachable' ? 'unreachable' : 'ok',
    account,
  };
}

function agentErrorKind(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const error = new Map(Object.entries(body)).get('error');
  return typeof error === 'string' ? error : null;
}

/**
 * One call to the account agent. Only the response's shape is read; its text is never logged or
 * forwarded. A request that cannot be made at all is the connector being unreachable.
 */
async function callAgent(
  deps: MailAccountClientDeps,
  input: { method: 'GET' | 'POST' | 'DELETE'; payload?: unknown; timeoutMs: number },
): Promise<{ status: number; body: unknown }> {
  if (deps.accountUrl === undefined) {
    throw new MailAccountError('connector_unreachable', MAIL_CONNECTOR_UNREACHABLE_MESSAGE);
  }
  const doFetch = deps.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(`${deps.accountUrl}/account`, {
      method: input.method,
      headers: input.payload === undefined ? {} : { 'Content-Type': 'application/json' },
      ...(input.payload === undefined ? {} : { body: JSON.stringify(input.payload) }),
      signal: AbortSignal.timeout(input.timeoutMs),
    });
  } catch {
    // No error text is logged: a failed request's message can carry the address it went to,
    // and this module never risks printing anything that travelled with the password.
    deps.logger.warn('Email account agent could not be reached');
    throw new MailAccountError('connector_unreachable', MAIL_CONNECTOR_UNREACHABLE_MESSAGE);
  }
  const body: unknown = await response.json().catch(() => null);
  return { status: response.status, body };
}

/** The saved account's state, asking the agent (which re-checks a stale sign-in answer). */
export async function getMailAccountState(deps: MailAccountClientDeps): Promise<MailAccountState> {
  const { status, body } = await callAgent(deps, { method: 'GET', timeoutMs: 45_000 });
  if (status !== 200) {
    deps.logger.warn('Email account agent answered a status request with an error');
    throw new MailAccountError('connector_unreachable', MAIL_STATUS_UNREACHABLE_MESSAGE);
  }
  return stateFromAgentBody(body);
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

/**
 * Saves the account through the agent, which checks the sign-in before storing anything.
 * A refused or unreachable check saves nothing, and the answer here is the fixed plain line.
 */
export async function saveMailAccount(
  deps: MailAccountClientDeps,
  request: MailAccountSaveRequest,
): Promise<MailAccountState> {
  const resolved = resolveMailAccountSave(request);
  if (!resolved.ok) {
    throw new MailAccountError('invalid_request', resolved.message);
  }
  const { status, body } = await callAgent(deps, { method: 'POST', payload: resolved.payload, timeoutMs: 45_000 });
  if (status === 200) {
    return stateFromAgentBody(body);
  }
  const kind = agentErrorKind(body);
  if (kind === 'sign_in_refused') {
    throw new MailAccountError('sign_in_refused', MAIL_SIGN_IN_REFUSED_MESSAGE);
  }
  if (kind === 'server_unreachable') {
    throw new MailAccountError('server_unreachable', MAIL_SERVER_UNREACHABLE_MESSAGE);
  }
  deps.logger.warn('Email account agent refused a save with an unexpected answer');
  throw new MailAccountError('connector_unreachable', MAIL_CONNECTOR_UNREACHABLE_MESSAGE);
}

/** Removes the saved account through the agent; the password is deleted from the account file. */
export async function removeMailAccount(deps: MailAccountClientDeps): Promise<MailAccountState> {
  const { status, body } = await callAgent(deps, { method: 'DELETE', timeoutMs: 15_000 });
  if (status !== 200) {
    deps.logger.warn('Email account agent refused a removal with an unexpected answer');
    throw new MailAccountError('connector_unreachable', MAIL_CONNECTOR_UNREACHABLE_MESSAGE);
  }
  return stateFromAgentBody(body);
}

/**
 * Brings the Email connector's registration in line with the saved account after a Settings
 * change or at boot: registered (with its send list prepared) when an account is saved, removed
 * when none is. Best effort: the account itself is already saved or removed, so a failure here
 * is logged, never thrown, and the next boot or change settles it.
 */
export async function syncMailConnectorWithAccount(deps: {
  state: MailAccountState;
  mcpUrl: string | undefined;
  policyPath: string | undefined;
  mcpServerStore: Pick<IMcpServerStore, 'upsertServer' | 'deleteServer'>;
  tenant_id: string;
  logger: Logger;
}): Promise<void> {
  try {
    if (deps.state.connected && deps.mcpUrl !== undefined) {
      await registerMailConnector({ url: deps.mcpUrl, mcpServerStore: deps.mcpServerStore, tenant_id: deps.tenant_id });
      await prepareMailPolicyAtBoot({ url: deps.mcpUrl, policyPath: deps.policyPath, logger: deps.logger });
    } else if (!deps.state.connected) {
      await unregisterMailConnector({ mcpServerStore: deps.mcpServerStore, tenant_id: deps.tenant_id });
    }
  } catch (error) {
    deps.logger.warn('Email connector registration could not be updated', extractErrorLogFields(error));
  }
}

/**
 * Boot step for an instance the installer never linked (no MCP endpoint in the configuration):
 * asks the account agent what is saved, in the background because its sign-in check can take a
 * few seconds, and registers the connector from the answer. Never keeps the server from starting.
 */
export function registerMailConnectorFromSavedAccountInBackground(deps: {
  accountUrl: string | undefined;
  mcpUrl: string | undefined;
  policyPath: string | undefined;
  fetchImpl: typeof fetch | undefined;
  mcpServerStore: Pick<IMcpServerStore, 'upsertServer' | 'deleteServer'>;
  tenant_id: string;
  logger: Logger;
}): void {
  if (deps.accountUrl === undefined || deps.mcpUrl === undefined) {
    return;
  }
  void (async () => {
    try {
      const state = await getMailAccountState({
        accountUrl: deps.accountUrl,
        fetchImpl: deps.fetchImpl,
        logger: deps.logger,
      });
      await syncMailConnectorWithAccount({
        state,
        mcpUrl: deps.mcpUrl,
        policyPath: deps.policyPath,
        mcpServerStore: deps.mcpServerStore,
        tenant_id: deps.tenant_id,
        logger: deps.logger,
      });
    } catch {
      deps.logger.warn('Email connector could not be registered from the saved account');
    }
  })();
}

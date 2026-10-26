/**
 * The Settings Calendar card's server side: talks to the calendar sidecar's account agent over the
 * instance's private network, and nowhere else. The app password arrives from the Settings form, is
 * checked here, and is passed to the agent in one request body. It is never stored by the app, never
 * logged, and never sent back: every response is built from the agent's public account view, which has
 * no password field, and every failure is one of the fixed plain messages below. The agent's own
 * response text is never forwarded or logged, because a calendar server's error can echo credentials.
 */
import { extractErrorLogFields } from '@truefoundry/trueforge-core/core';
import {
  CALDAV_OTHER_NEEDS_ADDRESS_MESSAGE,
  CALDAV_OTHER_PROVIDER_KEY,
  caldavEmailProblem,
  caldavGmxDomainMessage,
  caldavPasswordProblem,
  caldavPresetUrl,
  caldavProviderPreset,
  caldavUrlProblem,
  caldavUserProblem,
  GOOGLE_ADDRESS_MESSAGE,
  isGoogleMailAddress,
} from '@truefoundry/trueforge-core/core/calendar/caldav/presets';
import type { Logger } from 'winston';
import type { IMcpServerStore } from '../db/mcpServerStore';
import { registerCalendarConnector, unregisterCalendarConnector } from './calendarConnector';
import { agentErrorKind, agentField, callAccountAgent } from './connectorAccountAgent';

export const CALENDAR_SIGN_IN_REFUSED_MESSAGE = 'That login was refused. Make a new app password and try again.';
export const CALENDAR_SERVER_UNREACHABLE_MESSAGE =
  "Couldn't reach that calendar address. Check the address and try again.";
export const CALENDAR_ADDRESS_NOT_ALLOWED_MESSAGE =
  'That calendar address cannot be used here. Use the address your provider gives you.';
export const CALENDAR_DETAILS_UNUSABLE_MESSAGE =
  'Those calendar details cannot be saved. Check the address, the login name and the app password, then try again.';
export const CALENDAR_CONNECTOR_UNREACHABLE_MESSAGE = "Couldn't reach the calendar connector. Try again.";
export const CALENDAR_STATUS_UNREACHABLE_MESSAGE = "Couldn't check your calendar just now. Try again.";

export type CalendarAccountFailure =
  'sign_in_refused' | 'server_unreachable' | 'address_not_allowed' | 'connector_unreachable' | 'invalid_request';

/** A save or status failure with a fixed plain message; the message is the whole contract. */
export class CalendarAccountError extends Error {
  readonly failure: CalendarAccountFailure;
  constructor(failure: CalendarAccountFailure, message: string) {
    super(message);
    this.name = 'CalendarAccountError';
    this.failure = failure;
  }
}

/** A saved account as the agent shows it: everything but the password. */
export interface PublicCalendarAccount {
  url: string;
  username: string;
  email: string;
}

/** The saved account's state as the card shows it; the password is never part of it. */
export interface CalendarAccountState {
  connected: boolean;
  /** The last sign-in check's answer for the saved account; null when no account is saved. */
  sign_in: 'ok' | 'refused' | 'unreachable' | null;
  account: PublicCalendarAccount | null;
}

export interface CalendarAccountClientDeps {
  /** The account agent's base address from configuration; undefined means the card is not offered. */
  accountUrl: string | undefined;
  /** Replaceable so tests never reach a real sidecar. */
  fetchImpl: typeof fetch | undefined;
  logger: Pick<Logger, 'warn'>;
}

/** What the person asked to save, before presets resolve it. */
export interface CalendarAccountSaveRequest {
  provider_key: string;
  email: string;
  password: string;
  username: string | undefined;
  calendar_url: string | undefined;
}

/** The exact body the agent takes for a save. */
export interface CalendarAgentPayload {
  url: string;
  username: string;
  password: string;
  email: string;
}

function parseAgentAccount(body: object): PublicCalendarAccount | null {
  const url = agentField(body, 'url');
  const username = agentField(body, 'username');
  const email = agentField(body, 'email');
  if (typeof url !== 'string' || typeof username !== 'string' || typeof email !== 'string') {
    return null;
  }
  return { url, username, email };
}

function stateFromAgentBody(body: unknown): CalendarAccountState {
  if (typeof body !== 'object' || body === null) {
    throw new CalendarAccountError('connector_unreachable', CALENDAR_CONNECTOR_UNREACHABLE_MESSAGE);
  }
  if (agentField(body, 'connected') !== true) {
    return { connected: false, sign_in: null, account: null };
  }
  const account = parseAgentAccount(body);
  if (account === null) {
    throw new CalendarAccountError('connector_unreachable', CALENDAR_CONNECTOR_UNREACHABLE_MESSAGE);
  }
  const signIn = agentField(body, 'sign_in');
  return {
    connected: true,
    sign_in: signIn === 'refused' ? 'refused' : signIn === 'unreachable' ? 'unreachable' : 'ok',
    account,
  };
}

async function callAgent(
  deps: CalendarAccountClientDeps,
  input: { method: 'GET' | 'POST' | 'DELETE'; payload?: unknown; timeoutMs: number },
): Promise<{ status: number; body: unknown }> {
  const answer = await callAccountAgent({
    accountUrl: deps.accountUrl,
    fetchImpl: deps.fetchImpl,
    logger: deps.logger,
    label: 'Calendar',
    ...input,
  });
  if (answer === null) {
    throw new CalendarAccountError('connector_unreachable', CALENDAR_CONNECTOR_UNREACHABLE_MESSAGE);
  }
  return answer;
}

/** The saved account's state, asking the agent (which re-checks a stale sign-in answer). */
export async function getCalendarAccountState(deps: CalendarAccountClientDeps): Promise<CalendarAccountState> {
  const { status, body } = await callAgent(deps, { method: 'GET', timeoutMs: 45_000 });
  if (status !== 200) {
    deps.logger.warn('Calendar account agent answered a status request with an error');
    throw new CalendarAccountError('connector_unreachable', CALENDAR_STATUS_UNREACHABLE_MESSAGE);
  }
  return stateFromAgentBody(body);
}

/**
 * Resolves a save request against the presets and the installer's own rules, in plain words.
 * Returns the exact payload for the agent. No message here ever contains the password.
 */
export function resolveCalendarAccountSave(
  request: CalendarAccountSaveRequest,
): { ok: true; payload: CalendarAgentPayload } | { ok: false; message: string } {
  const emailProblem = caldavEmailProblem(request.email);
  if (emailProblem !== null) {
    return { ok: false, message: emailProblem };
  }
  if (isGoogleMailAddress(request.email)) {
    return { ok: false, message: GOOGLE_ADDRESS_MESSAGE };
  }
  if (caldavProviderPreset(request.provider_key) === undefined) {
    return { ok: false, message: 'That calendar provider is not on the list. Pick one and try again.' };
  }
  const isOther = request.provider_key === CALDAV_OTHER_PROVIDER_KEY;
  if (!isOther && request.calendar_url !== undefined) {
    return {
      ok: false,
      message: 'A typed calendar address is only for the Other provider. Pick Other, or remove the address.',
    };
  }
  let url: string;
  if (isOther) {
    if (request.calendar_url === undefined || request.calendar_url.trim() === '') {
      return { ok: false, message: CALDAV_OTHER_NEEDS_ADDRESS_MESSAGE };
    }
    url = request.calendar_url.trim();
  } else {
    const preset = caldavPresetUrl({ provider_key: request.provider_key, email: request.email });
    if (preset === null) {
      return { ok: false, message: caldavGmxDomainMessage(request.email) };
    }
    url = preset;
  }
  const urlProblem = caldavUrlProblem(url);
  if (urlProblem !== null) {
    return { ok: false, message: urlProblem };
  }
  const username =
    request.username === undefined || request.username.trim() === '' ? request.email : request.username.trim();
  const userProblem = caldavUserProblem(username);
  if (userProblem !== null) {
    return { ok: false, message: userProblem };
  }
  const passwordProblem = caldavPasswordProblem(request.password);
  if (passwordProblem !== null) {
    return { ok: false, message: passwordProblem };
  }
  return { ok: true, payload: { url, username, password: request.password, email: request.email } };
}

/**
 * Saves the account through the agent, which checks the address rules and the sign-in before storing
 * anything. A refused or unreachable check saves nothing, and the answer here is the fixed plain line.
 */
export async function saveCalendarAccount(
  deps: CalendarAccountClientDeps,
  request: CalendarAccountSaveRequest,
): Promise<CalendarAccountState> {
  const resolved = resolveCalendarAccountSave(request);
  if (!resolved.ok) {
    throw new CalendarAccountError('invalid_request', resolved.message);
  }
  const { status, body } = await callAgent(deps, { method: 'POST', payload: resolved.payload, timeoutMs: 45_000 });
  if (status === 200) {
    return stateFromAgentBody(body);
  }
  const kind = agentErrorKind(body);
  if (kind === 'sign_in_refused') {
    throw new CalendarAccountError('sign_in_refused', CALENDAR_SIGN_IN_REFUSED_MESSAGE);
  }
  if (kind === 'server_unreachable') {
    throw new CalendarAccountError('server_unreachable', CALENDAR_SERVER_UNREACHABLE_MESSAGE);
  }
  if (kind === 'address_not_allowed') {
    throw new CalendarAccountError('address_not_allowed', CALENDAR_ADDRESS_NOT_ALLOWED_MESSAGE);
  }
  if (kind === 'invalid') {
    throw new CalendarAccountError('invalid_request', CALENDAR_DETAILS_UNUSABLE_MESSAGE);
  }
  deps.logger.warn('Calendar account agent refused a save with an unexpected answer');
  throw new CalendarAccountError('connector_unreachable', CALENDAR_CONNECTOR_UNREACHABLE_MESSAGE);
}

/** Removes the saved account through the agent; the password is deleted for good. */
export async function removeCalendarAccount(deps: CalendarAccountClientDeps): Promise<CalendarAccountState> {
  const { status, body } = await callAgent(deps, { method: 'DELETE', timeoutMs: 15_000 });
  if (status !== 200) {
    deps.logger.warn('Calendar account agent refused a removal with an unexpected answer');
    throw new CalendarAccountError('connector_unreachable', CALENDAR_CONNECTOR_UNREACHABLE_MESSAGE);
  }
  return stateFromAgentBody(body);
}

/**
 * Brings the Calendar connector's registration in line with the saved account after a Settings change
 * or at boot: registered when an account is saved, removed when none is. A connector left registered
 * with no account behind it would offer calendar tools that can only fail, and "set up" for the chat
 * defaults means registered. Best effort: the account itself is already saved or removed, so a failure
 * here is logged, never thrown, and the next boot or change settles it.
 */
export async function syncCalendarConnectorWithAccount(deps: {
  state: CalendarAccountState;
  mcpUrl: string | undefined;
  mcpServerStore: Pick<IMcpServerStore, 'upsertServer' | 'deleteServer'>;
  tenant_id: string;
  logger: Pick<Logger, 'warn'>;
}): Promise<void> {
  try {
    if (deps.state.connected) {
      await registerCalendarConnector({
        url: deps.mcpUrl,
        mcpServerStore: deps.mcpServerStore,
        tenant_id: deps.tenant_id,
      });
    } else {
      await unregisterCalendarConnector({ mcpServerStore: deps.mcpServerStore, tenant_id: deps.tenant_id });
    }
  } catch (error) {
    deps.logger.warn('Calendar connector registration could not be updated', extractErrorLogFields(error));
  }
}

/**
 * Boot step: asks the account agent what is saved and registers the connector from the answer, in the
 * background because its sign-in check can take a few seconds. The sidecar may still be starting when the
 * app boots, so an unreachable agent is asked again a few times. Never keeps the server from starting.
 */
export function registerCalendarConnectorFromSavedAccountInBackground(deps: {
  accountUrl: string | undefined;
  mcpUrl: string | undefined;
  fetchImpl: typeof fetch | undefined;
  mcpServerStore: Pick<IMcpServerStore, 'upsertServer' | 'deleteServer'>;
  tenant_id: string;
  logger: Pick<Logger, 'warn'>;
  retry: { attempts: number; delayMs: number };
}): Promise<void> {
  if (deps.accountUrl === undefined) {
    return Promise.resolve();
  }
  const accountUrl = deps.accountUrl;
  return (async () => {
    for (let attempt = 1; attempt <= deps.retry.attempts; attempt += 1) {
      try {
        const state = await getCalendarAccountState({
          accountUrl,
          fetchImpl: deps.fetchImpl,
          logger: deps.logger,
        });
        await syncCalendarConnectorWithAccount({
          state,
          mcpUrl: deps.mcpUrl,
          mcpServerStore: deps.mcpServerStore,
          tenant_id: deps.tenant_id,
          logger: deps.logger,
        });
        return;
      } catch {
        if (attempt < deps.retry.attempts) {
          await new Promise(resolve => setTimeout(resolve, deps.retry.delayMs));
        }
      }
    }
    deps.logger.warn('Calendar connector could not be registered from the saved account');
  })();
}

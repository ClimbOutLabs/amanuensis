/**
 * The Settings Calendar card's kind: what differs from the Email card. The client, the failures and the
 * registration step are shared (see connectorAccount.ts); this file holds the calendar account's shape,
 * its plain lines, and how a save request is resolved against the presets.
 */
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
import {
  registerCalendarConnector,
  registerCalendarConnectorAtBoot,
  unregisterCalendarConnector,
} from './calendarConnector';
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

export const CALENDAR_SIGN_IN_REFUSED_MESSAGE = 'That login was refused. Make a new app password and try again.';
export const CALENDAR_SERVER_UNREACHABLE_MESSAGE =
  "Couldn't reach that calendar address. Check the address and try again.";
export const CALENDAR_CERTIFICATE_MESSAGE =
  "That calendar server's security certificate was not accepted. Use the address your provider gives you and try again.";
export const CALENDAR_REDIRECT_MESSAGE =
  'That calendar address sends you to a different server. Use the address your provider gives you and try again.';
export const CALENDAR_ADDRESS_NOT_ALLOWED_MESSAGE =
  'That calendar address cannot be used here. Use the address your provider gives you.';
export const CALENDAR_DETAILS_UNUSABLE_MESSAGE =
  'Those calendar details cannot be saved. Check the address, the login name and the app password, then try again.';
export const CALENDAR_CONNECTOR_UNREACHABLE_MESSAGE = "Couldn't reach the calendar connector. Try again.";
export const CALENDAR_STATUS_UNREACHABLE_MESSAGE = "Couldn't check your calendar just now. Try again.";

/** What the connector says is wrong with one value, in plain words and with the one thing to do. */
const INVALID_FIELD_MESSAGES: ReadonlyMap<string, string> = new Map([
  ['url', "That calendar address cannot be saved. Copy it again from your provider's help page and try again."],
  ['username', 'That login name has a character that cannot be saved. Use letters, numbers and . _ + @ = - only.'],
  ['password', 'That app password has a character that cannot be saved. Make a new app password and try again.'],
  ['email', 'That email address has a character that cannot be saved. Use plain letters and numbers and try again.'],
]);

/** A saved account as the agent shows it: everything but the password. */
export interface PublicCalendarAccount {
  url: string;
  username: string;
  email: string;
}

/** The saved account's state as the card shows it; the password is never part of it. */
export type CalendarAccountState = ConnectorAccountState<PublicCalendarAccount>;

/** What the person asked to save, before presets resolve it. */
export interface CalendarAccountSaveRequest {
  provider_key: string;
  email: string;
  password: string;
  username: string | undefined;
  calendar_url: string | undefined;
}

/** The exact body the agent takes for a save. */
interface CalendarAgentPayload {
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

function invalidFieldMessage(body: unknown): string {
  const field = typeof body === 'object' && body !== null ? agentField(body, 'field') : undefined;
  return (
    (typeof field === 'string' ? INVALID_FIELD_MESSAGES.get(field) : undefined) ?? CALENDAR_DETAILS_UNUSABLE_MESSAGE
  );
}

const calendarKind: ConnectorAccountKind<PublicCalendarAccount> = {
  label: 'Calendar',
  parseAccount: parseAgentAccount,
  connectorUnreachableMessage: CALENDAR_CONNECTOR_UNREACHABLE_MESSAGE,
  statusUnreachableMessage: CALENDAR_STATUS_UNREACHABLE_MESSAGE,
  saveRefusal: body => {
    switch (agentErrorKind(body)) {
      case 'sign_in_refused':
        return { failure: 'sign_in_refused', message: CALENDAR_SIGN_IN_REFUSED_MESSAGE };
      case 'server_unreachable':
        return { failure: 'server_unreachable', message: CALENDAR_SERVER_UNREACHABLE_MESSAGE };
      case 'certificate_refused':
        return { failure: 'certificate_refused', message: CALENDAR_CERTIFICATE_MESSAGE };
      case 'redirected':
        return { failure: 'redirected', message: CALENDAR_REDIRECT_MESSAGE };
      case 'address_not_allowed':
        return { failure: 'address_not_allowed', message: CALENDAR_ADDRESS_NOT_ALLOWED_MESSAGE };
      case 'invalid':
        return { failure: 'invalid_request', message: invalidFieldMessage(body) };
      default:
        return null;
    }
  },
};

const calendarClient = createConnectorAccountClient(calendarKind);

/** The saved account's state, asking the agent (which re-checks a stale sign-in answer). */
export function getCalendarAccountState(deps: ConnectorAccountClientDeps): Promise<CalendarAccountState> {
  return calendarClient.getState(deps);
}

/**
 * Resolves a save request against the presets and the installer's own rules, in plain words.
 * Returns the exact payload for the agent. No message here ever contains the password.
 */
function resolveCalendarAccountSave(
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

/** Saves the account through the agent, which checks the address rules and the sign-in before storing anything. */
export async function saveCalendarAccount(
  deps: ConnectorAccountClientDeps,
  request: CalendarAccountSaveRequest,
): Promise<CalendarAccountState> {
  const resolved = resolveCalendarAccountSave(request);
  if (!resolved.ok) {
    throw new ConnectorAccountError({ failure: 'invalid_request', message: resolved.message });
  }
  return calendarClient.save(deps, resolved.payload);
}

/** Removes the saved account through the agent; the password is deleted for good. */
export function removeCalendarAccount(deps: ConnectorAccountClientDeps): Promise<CalendarAccountState> {
  return calendarClient.remove(deps);
}

/**
 * Registers the Calendar connector while an account is saved and working, and removes it otherwise, so
 * "set up" for the chat defaults means a working calendar. The removal touches only a record at the
 * calendar sidecar's own address, never another connector that happens to share the name.
 */
export function syncCalendarConnectorWithAccount(deps: {
  state: CalendarAccountState;
  mcpUrl: string | undefined;
  mcpServerStore: Pick<IMcpServerStore, 'upsertServer' | 'deleteServer' | 'getServer'>;
  tenant_id: string;
  logger: Pick<Logger, 'warn'>;
}): Promise<void> {
  return syncConnectorRegistration({
    state: deps.state,
    label: 'Calendar',
    logger: deps.logger,
    registration: {
      register: async () => {
        await registerCalendarConnector({
          url: deps.mcpUrl,
          mcpServerStore: deps.mcpServerStore,
          tenant_id: deps.tenant_id,
        });
      },
      unregister: () =>
        unregisterCalendarConnector({
          url: deps.mcpUrl,
          mcpServerStore: deps.mcpServerStore,
          tenant_id: deps.tenant_id,
        }),
    },
  });
}

/**
 * Boot step: keeps the Calendar connector in line with the saved account, retrying with a growing wait
 * while the account agent is unreachable.
 */
export function registerCalendarConnectorFromSavedAccountInBackground(deps: {
  accountUrl: string;
  secret: string;
  mcpUrl: string | undefined;
  fetchImpl: typeof fetch | undefined;
  mcpServerStore: Pick<IMcpServerStore, 'upsertServer' | 'deleteServer' | 'getServer'>;
  tenant_id: string;
  logger: Pick<Logger, 'warn'>;
  backoff?: BackoffPlan | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
}): Promise<void> {
  const clientDeps = {
    accountUrl: deps.accountUrl,
    secret: deps.secret,
    fetchImpl: deps.fetchImpl,
    logger: deps.logger,
  };
  return keepConnectorInStepInBackground({
    readState: () => getCalendarAccountState(clientDeps),
    apply: state =>
      syncCalendarConnectorWithAccount({
        state,
        mcpUrl: deps.mcpUrl,
        mcpServerStore: deps.mcpServerStore,
        tenant_id: deps.tenant_id,
        logger: deps.logger,
      }),
    logger: deps.logger,
    label: 'Calendar',
    backoff: deps.backoff,
    sleep: deps.sleep,
  });
}

/**
 * Boot step for the Calendar connector. With an account agent configured, the connector is registered only
 * while an account is saved, and the agent is asked in the background (retrying while it is unreachable). With
 * no agent, an operator runs their own calendar sidecar and the configured endpoint is registered as it always
 * was. An agent address without its secret cannot be asked, so the connector is left unregistered and the log
 * says why.
 */
export async function registerCalendarConnectorForBoot(deps: {
  accountUrl: string | undefined;
  secret: string | undefined;
  connectorUrl: string | undefined;
  mcpUrl: string | undefined;
  fetchImpl: typeof fetch | undefined;
  mcpServerStore: Pick<IMcpServerStore, 'upsertServer' | 'deleteServer' | 'getServer'>;
  tenant_id: string;
  logger: Pick<Logger, 'warn'>;
  backoff?: BackoffPlan | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
}): Promise<void> {
  if (deps.accountUrl === undefined) {
    await registerCalendarConnectorAtBoot({
      url: deps.connectorUrl,
      mcpServerStore: deps.mcpServerStore,
      tenant_id: deps.tenant_id,
      logger: deps.logger,
    });
    return;
  }
  if (deps.secret === undefined) {
    deps.logger.warn(
      'Calendar connector is off: CALENDAR_ACCOUNT_SECRET is not set. Set it to turn the Calendar card on.',
    );
    return;
  }
  void registerCalendarConnectorFromSavedAccountInBackground({
    accountUrl: deps.accountUrl,
    secret: deps.secret,
    mcpUrl: deps.mcpUrl,
    fetchImpl: deps.fetchImpl,
    mcpServerStore: deps.mcpServerStore,
    tenant_id: deps.tenant_id,
    logger: deps.logger,
    backoff: deps.backoff,
    sleep: deps.sleep,
  });
}

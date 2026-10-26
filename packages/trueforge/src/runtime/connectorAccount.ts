/**
 * What the Settings Email and Calendar cards share on the server: the client for a sidecar's account
 * agent, the plain failures it can end in, and the step that keeps the connector's registration in line
 * with the saved account. A kind (Email, Calendar) supplies only what differs: how to read its account
 * out of an answer, which plain lines its refusals use, and how its connector is registered.
 *
 * The app password passes through a save call to the agent only. It is never stored here, never logged
 * and never sent back: every state is built from the agent's public account view, and every failure is
 * one of the fixed plain lines a kind supplies. The agent's own response text is never forwarded or
 * logged, because a server's error can echo credentials.
 */
import { extractErrorLogFields } from '@truefoundry/trueforge-core/core';
import type { Logger } from 'winston';
import { agentField, callAccountAgent } from './connectorAccountAgent';

export type ConnectorAccountFailure =
  | 'sign_in_refused'
  | 'server_unreachable'
  | 'address_not_allowed'
  | 'certificate_refused'
  | 'redirected'
  | 'connector_unreachable'
  | 'invalid_request';

/** A save or status failure with a fixed plain message; the message is the whole contract. */
export class ConnectorAccountError extends Error {
  readonly failure: ConnectorAccountFailure;
  constructor({ failure, message, cause }: { failure: ConnectorAccountFailure; message: string; cause?: unknown }) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ConnectorAccountError';
    this.failure = failure;
  }
}

/** The last sign-in check's answer for the saved account. */
export type SignInAnswer = 'ok' | 'refused' | 'unreachable';

/** The saved account's state as a card shows it; the password is never part of it. */
export interface ConnectorAccountState<TAccount> {
  connected: boolean;
  /** Null when no account is saved. */
  sign_in: SignInAnswer | null;
  account: TAccount | null;
}

export interface ConnectorAccountClientDeps {
  /** The account agent's base address from configuration; undefined means the card is not offered. */
  accountUrl: string | undefined;
  /** What the agent needs before it answers, when it needs one; the Email agent needs none. */
  secret?: string | undefined;
  /** Replaceable so tests never reach a real sidecar. */
  fetchImpl: typeof fetch | undefined;
  logger: Pick<Logger, 'warn'>;
}

export interface ConnectorAccountKind<TAccount> {
  /** Names the connector in the one log line, such as Email. */
  label: string;
  /** The agent's public account view, as parsed from an answer; unknown shapes parse to null. */
  parseAccount(body: object): TAccount | null;
  connectorUnreachableMessage: string;
  statusUnreachableMessage: string;
  /** The plain failure for a save the agent refused, or null for an answer this kind does not know. */
  saveRefusal(body: unknown): { failure: ConnectorAccountFailure; message: string } | null;
}

/** How a kind registers and removes its connector; both may fail, and the caller keeps going. */
export interface ConnectorRegistration {
  register(): Promise<void>;
  unregister(): Promise<void>;
}

const SAVE_TIMEOUT_MS = 45_000;
const STATUS_TIMEOUT_MS = 45_000;
const REMOVE_TIMEOUT_MS = 15_000;

function signInAnswer(value: unknown): SignInAnswer {
  return value === 'refused' ? 'refused' : value === 'unreachable' ? 'unreachable' : 'ok';
}

/** The client for one kind's account agent: read the state, save an account, remove it. */
export function createConnectorAccountClient<TAccount>(kind: ConnectorAccountKind<TAccount>) {
  function unreachable({ message, cause }: { message: string; cause?: unknown }): ConnectorAccountError {
    return new ConnectorAccountError({ failure: 'connector_unreachable', message, cause });
  }

  function stateFromBody(body: unknown): ConnectorAccountState<TAccount> {
    if (typeof body !== 'object' || body === null) {
      throw unreachable({ message: kind.connectorUnreachableMessage });
    }
    if (agentField(body, 'connected') !== true) {
      return { connected: false, sign_in: null, account: null };
    }
    const account = kind.parseAccount(body);
    if (account === null) {
      throw unreachable({ message: kind.connectorUnreachableMessage });
    }
    return { connected: true, sign_in: signInAnswer(agentField(body, 'sign_in')), account };
  }

  async function call(
    deps: ConnectorAccountClientDeps,
    input: { method: 'GET' | 'POST' | 'DELETE'; payload?: unknown; timeoutMs: number },
  ): Promise<{ status: number; body: unknown }> {
    if (deps.accountUrl === undefined) {
      throw unreachable({ message: kind.connectorUnreachableMessage });
    }
    const answer = await callAccountAgent({
      accountUrl: deps.accountUrl,
      secret: deps.secret,
      fetchImpl: deps.fetchImpl,
      logger: deps.logger,
      label: kind.label,
      ...input,
    });
    if (!answer.reached) {
      throw unreachable({ message: kind.connectorUnreachableMessage, cause: answer.cause });
    }
    return answer;
  }

  return {
    /** The saved account's state, asking the agent (which re-checks a stale sign-in answer). */
    async getState(deps: ConnectorAccountClientDeps): Promise<ConnectorAccountState<TAccount>> {
      const { status, body } = await call(deps, { method: 'GET', timeoutMs: STATUS_TIMEOUT_MS });
      if (status !== 200) {
        deps.logger.warn(`${kind.label} account agent answered a status request with an error`);
        throw unreachable({ message: kind.statusUnreachableMessage });
      }
      return stateFromBody(body);
    },

    /**
     * Saves an account through the agent, which checks the sign-in before storing anything. A refused or
     * unreachable check saves nothing, and the answer is the kind's fixed plain line.
     */
    async save(deps: ConnectorAccountClientDeps, payload: unknown): Promise<ConnectorAccountState<TAccount>> {
      const { status, body } = await call(deps, { method: 'POST', payload, timeoutMs: SAVE_TIMEOUT_MS });
      if (status === 200) {
        return stateFromBody(body);
      }
      const refusal = kind.saveRefusal(body);
      if (refusal !== null) {
        throw new ConnectorAccountError(refusal);
      }
      deps.logger.warn(`${kind.label} account agent refused a save with an unexpected answer`);
      throw unreachable({ message: kind.connectorUnreachableMessage });
    },

    /** Removes the saved account through the agent; the password is deleted from the account file. */
    async remove(deps: ConnectorAccountClientDeps): Promise<ConnectorAccountState<TAccount>> {
      const { status, body } = await call(deps, { method: 'DELETE', timeoutMs: REMOVE_TIMEOUT_MS });
      if (status !== 200) {
        deps.logger.warn(`${kind.label} account agent refused a removal with an unexpected answer`);
        throw unreachable({ message: kind.connectorUnreachableMessage });
      }
      return stateFromBody(body);
    },
  };
}

/** The card's one word for the account: saved and working, saved but refused, saved but unreachable, or none. */
export function connectionStateOf<TAccount>(
  state: ConnectorAccountState<TAccount>,
): 'connected' | 'not_connected' | 'sign_in_stopped' | 'not_working' {
  if (!state.connected) {
    return 'not_connected';
  }
  return state.sign_in === 'refused'
    ? 'sign_in_stopped'
    : state.sign_in === 'unreachable'
      ? 'not_working'
      : 'connected';
}

/** The connector is registered while an account is saved and its sign-in has not been refused. */
function shouldRegisterConnector<TAccount>(state: ConnectorAccountState<TAccount>): boolean {
  return state.connected && state.sign_in !== 'refused';
}

/**
 * Brings the connector's registration in line with the agent's real answer: registered while an account is
 * saved and working, removed when none is or its sign-in was refused. A connector left registered with no
 * working account behind it would offer tools that can only fail. Best effort: the account itself is already
 * saved or removed, so a failure here is logged, never thrown, and the next status read or boot settles it.
 */
export async function syncConnectorRegistration<TAccount>({
  state,
  registration,
  logger,
  label,
}: {
  state: ConnectorAccountState<TAccount>;
  registration: ConnectorRegistration;
  logger: Pick<Logger, 'warn'>;
  label: string;
}): Promise<void> {
  try {
    if (shouldRegisterConnector(state)) {
      await registration.register();
    } else {
      await registration.unregister();
    }
  } catch (error) {
    logger.warn(`${label} connector registration could not be updated`, extractErrorLogFields(error));
  }
}

export interface BackoffPlan {
  initialDelayMs: number;
  maxDelayMs: number;
  /** How many reads to try before giving up. */
  attempts: number;
}

/** The boot waits 3 seconds, then twice as long each time up to 5 minutes, and never gives up. */
const BOOT_BACKOFF: BackoffPlan = {
  initialDelayMs: 3000,
  maxDelayMs: 300_000,
  attempts: Number.POSITIVE_INFINITY,
};

function waitMs(ms: number): Promise<void> {
  return new Promise(resolve => {
    // Unreferenced, so a server that is shutting down is not held open by a wait.
    setTimeout(resolve, ms).unref();
  });
}

/**
 * Boot step: asks the account agent what is saved and keeps the registration in line with the answer, in the
 * background because its sign-in check can take a few seconds. The sidecar may still be starting, or down for a
 * while, so an unreachable agent is asked again with a growing wait until it answers. Never keeps the server
 * from starting.
 */
export async function keepConnectorInStepInBackground<TAccount>({
  readState,
  apply,
  logger,
  label,
  backoff = BOOT_BACKOFF,
  sleep = waitMs,
}: {
  readState: () => Promise<ConnectorAccountState<TAccount>>;
  apply: (state: ConnectorAccountState<TAccount>) => Promise<void>;
  logger: Pick<Logger, 'warn'>;
  label: string;
  backoff?: BackoffPlan | undefined;
  /** Replaceable so tests do not wait. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
}): Promise<void> {
  let delay = backoff.initialDelayMs;
  for (let attempt = 1; attempt <= backoff.attempts; attempt += 1) {
    try {
      await apply(await readState());
      return;
    } catch {
      // The reason is already logged as a fixed line by the client; only the first failure is repeated here.
      if (attempt === 1) {
        logger.warn(`${label} connector could not be registered yet; trying again until the account agent answers`);
      }
    }
    if (attempt < backoff.attempts) {
      await sleep(delay);
      delay = Math.min(delay * 2, backoff.maxDelayMs);
    }
  }
}

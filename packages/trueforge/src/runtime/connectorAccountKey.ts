import { createHash } from 'node:crypto';
import { agentErrorKind, agentField, callAccountAgent } from './connectorAccountAgent';

/** The key a connector's account file is encrypted with, and the keys it may still be under after a move. */
export interface ConnectorAccountKeys {
  current: Buffer;
  earlier: Buffer[];
}

/** The short name an account agent gives the key it holds, so the key itself never travels to be compared. */
export function connectorKeyId(key: Buffer): string {
  return createHash('sha256').update('aman connector key id').update(key).digest('hex').slice(0, 16);
}

/**
 * `held`: the agent already had the key. `delivered`: it took the key now. `wrong_key`: its file is under a
 * key this instance does not have. `no_cipher`: the connector cannot encrypt. `refused` and `unreachable`:
 * no usable answer came.
 */
export type ConnectorKeyOutcome = 'held' | 'delivered' | 'wrong_key' | 'no_cipher' | 'refused' | 'unreachable';

const KEY_CALL_MS = 10_000;

export interface ConnectorKeyDeps {
  accountUrl: string;
  secret: string;
  keys: ConnectorAccountKeys;
  /** Names the connector in log lines, such as Email. */
  label: string;
  fetchImpl: typeof fetch | undefined;
}

/** Hands the agent the key of its account file unless it already holds it. The key is never logged. */
export async function deliverConnectorKey(deps: ConnectorKeyDeps): Promise<ConnectorKeyOutcome> {
  const shared = {
    accountUrl: deps.accountUrl,
    secret: deps.secret,
    fetchImpl: deps.fetchImpl,
    // Asked every few seconds, so an agent that is down is reported once by the caller, not on each call.
    logger: undefined,
    label: deps.label,
    path: '/key',
    timeoutMs: KEY_CALL_MS,
  };
  const held = await callAccountAgent({ ...shared, method: 'GET' });
  if (!held.reached) {
    return 'unreachable';
  }
  if (
    held.status === 200 &&
    typeof held.body === 'object' &&
    held.body !== null &&
    agentField(held.body, 'key_id') === connectorKeyId(deps.keys.current)
  ) {
    return 'held';
  }
  const taken = await callAccountAgent({
    ...shared,
    method: 'POST',
    payload: {
      current: deps.keys.current.toString('hex'),
      earlier: deps.keys.earlier.map(key => key.toString('hex')),
    },
  });
  if (!taken.reached) {
    return 'unreachable';
  }
  if (taken.status === 200) {
    return 'delivered';
  }
  const word = agentErrorKind(taken.body);
  return word === 'wrong_key' || word === 'no_cipher' ? word : 'refused';
}

const OUTCOME_LINES: Record<Exclude<ConnectorKeyOutcome, 'held' | 'delivered'>, string> = {
  wrong_key:
    'saved accounts were encrypted with a key this instance does not have, so they stay locked. Remove the account in Settings and connect it again.',
  no_cipher: 'connector cannot encrypt its account file, so no account can be saved. Run the installer upgrade.',
  refused: 'connector did not take the key of its account file; trying again.',
  unreachable: 'connector could not be reached to hand it the key of its account file; trying again.',
};

function waitMs(ms: number): Promise<void> {
  return new Promise(resolve => {
    // Unreferenced, so a server that is shutting down is not held open by a wait.
    setTimeout(resolve, ms).unref();
  });
}

/**
 * The agent keeps the key in memory only, so it has none after each of its own restarts. This asks it every
 * few seconds which key it holds and hands the key over again when it has none. One line is logged when the
 * outcome changes, never one per round.
 */
export async function keepConnectorKeyDelivered({
  logger,
  intervalMs = 3000,
  sleep = waitMs,
  rounds = Number.POSITIVE_INFINITY,
  ...deps
}: ConnectorKeyDeps & {
  logger: { info(message: string): unknown; warn(message: string): unknown };
  intervalMs?: number | undefined;
  /** Replaceable so tests do not wait. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
  /** How many times to ask; tests stop after a few. */
  rounds?: number | undefined;
}): Promise<void> {
  let last: ConnectorKeyOutcome | undefined;
  for (let round = 0; round < rounds; round += 1) {
    const outcome = await deliverConnectorKey(deps);
    if (outcome !== last && outcome !== 'held') {
      if (outcome === 'delivered') {
        logger.info(`${deps.label} connector was handed the key of its account file`);
      } else {
        logger.warn(`${deps.label} ${OUTCOME_LINES[outcome]}`);
      }
    }
    last = outcome;
    if (round + 1 < rounds) {
      await sleep(intervalMs);
    }
  }
}

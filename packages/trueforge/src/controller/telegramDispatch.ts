import type { ISessionStore } from '@truefoundry/trueforge-core/agent-session';
import type { Logger } from 'winston';

import configuration from '../config';
import type { SessionCustom, TurnCustom } from '../db/sessionCustom';
import type { ITelegramStore } from '../db/telegramStore';
import { createTlsFetch, normalizeTlsUrl } from '../http/tls';
import { deliverPendingTelegramReplies } from '../runtime/telegram/telegramReplies';
import { createTelegramSendQueue } from '../runtime/telegram/telegramSendQueue';
import type { TelegramService } from '../runtime/telegram/telegramService';
import type { TelegramUpdate } from '../schemas/telegram';
import type { ControlLoop } from './Controller';

/**
 * The controller side of the Telegram channel: one loop long-polls Telegram for each connected
 * bot and hands every update to the server over HTTP, the way schedule dispatch hands over runs;
 * one loop sends the replies finished turns owe Telegram. Polling is single-flight per connection
 * (the loop's own pass is the only poller, and a pass does not overlap itself), the stored offset
 * advances only for updates the server accepted, and a failing connection backs off instead of
 * spinning.
 */

export const TELEGRAM_POLL_LOOP_NAME = 'telegram-poll';
export const TELEGRAM_POLL_INTERVAL_MS = 1000;
export const TELEGRAM_REPLY_LOOP_NAME = 'telegram-replies';
export const TELEGRAM_REPLY_INTERVAL_MS = 3000;

const BACKOFF_BASE_MS = 5000;
const BACKOFF_CAP_MS = 60_000;

/** How long a connection waits after `consecutiveFailures` failed passes in a row: 10s, 20s, 40s, then a minute. */
export function telegramPollBackoffMs(consecutiveFailures: number): number {
  return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(1, consecutiveFailures));
}

/** Hands one polled update to the server. A throw means the server did not accept it. */
export type TelegramUpdateExecutor = (input: { connection_id: string; update: TelegramUpdate }) => Promise<void>;

/** The production executor: POSTs to the internal endpoint with the service key. */
export function createHttpTelegramUpdateExecutor(): TelegramUpdateExecutor {
  const tls = {
    enabled: configuration.TRUEFORGE_MTLS_ENABLED,
    dir: configuration.TRUEFORGE_MTLS_CERTS_DIR,
  };
  const tlsFetch = createTlsFetch(tls);
  const baseUrl = normalizeTlsUrl({ url: configuration.SERVER_URL, enabled: tls.enabled });
  const fetchImpl = tlsFetch ?? ((input: string, init?: RequestInit) => fetch(input, init));
  return async ({ connection_id, update }) => {
    const response = await fetchImpl(`${baseUrl}/api/internal/telegram/updates`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${configuration.TRUEFORGE_API_KEY}`,
      },
      body: JSON.stringify({ connection_id, update }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      throw new Error(`The server refused a Telegram update with status ${String(response.status)}.`);
    }
  };
}

interface ConnectionPollState {
  failures: number;
  nextAttemptAt: number;
}

/**
 * One polling pass over every polling connection. Per connection: ask Telegram for the updates
 * after the stored offset, hand each to the server in order, and store the new offset as they
 * are accepted. The first failure stops that connection for this pass and starts its backoff;
 * other connections are unaffected. An update Telegram sent in a shape that cannot be read is
 * not a failure: the client skips it, the pass logs the skip, and the offset moves past it.
 */
export async function pollTelegramOnce(params: {
  store: ITelegramStore;
  service: TelegramService;
  executeUpdate: TelegramUpdateExecutor;
  logger: Logger;
  signal: AbortSignal;
  state: Map<string, ConnectionPollState>;
  now?: () => number;
}): Promise<void> {
  const now = params.now ?? (() => Date.now());
  const connections = await params.store.listConnections();
  for (const connection of connections) {
    if (connection.transport !== 'polling') {
      continue;
    }
    const state = params.state.get(connection.id) ?? { failures: 0, nextAttemptAt: 0 };
    params.state.set(connection.id, state);
    if (now() < state.nextAttemptAt) {
      continue;
    }
    const owner = { tenant_id: connection.tenant_id, created_by: connection.created_by };
    try {
      const client = params.service.clientFor(connection);
      const updates = await client.getUpdates({
        offset: connection.poll_offset,
        signal: params.signal,
        onSkippedUpdate: ({ update_id }) => {
          params.logger.warn('A Telegram update could not be read and was skipped', {
            connection_id: connection.id,
            update_id,
          });
        },
      });
      let offset = connection.poll_offset;
      for (const update of updates) {
        await params.executeUpdate({ connection_id: connection.id, update });
        offset = String(update.update_id + 1);
        await params.store.setPollOffset({ ...owner, poll_offset: offset });
      }
      state.failures = 0;
      state.nextAttemptAt = 0;
    } catch (error) {
      if (params.signal.aborted) {
        return;
      }
      state.failures += 1;
      state.nextAttemptAt = now() + telegramPollBackoffMs(state.failures);
      params.logger.warn('Telegram polling failed; backing off', {
        connection_id: connection.id,
        failures: state.failures,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export function telegramPollLoop(params: {
  store: ITelegramStore;
  service: TelegramService;
  executeUpdate?: TelegramUpdateExecutor;
  logger: Logger;
}): ControlLoop {
  const executeUpdate = params.executeUpdate ?? createHttpTelegramUpdateExecutor();
  const state = new Map<string, ConnectionPollState>();
  return {
    name: TELEGRAM_POLL_LOOP_NAME,
    intervalMs: TELEGRAM_POLL_INTERVAL_MS,
    async tick(signal: AbortSignal): Promise<void> {
      await pollTelegramOnce({
        store: params.store,
        service: params.service,
        executeUpdate,
        logger: params.logger,
        signal,
        state,
      });
    },
  };
}

export function telegramReplyLoop(params: {
  store: ITelegramStore;
  service: TelegramService;
  sessionStore: Pick<ISessionStore<SessionCustom, TurnCustom>, 'getTurn'>;
  logger: Logger;
}): ControlLoop {
  const queue = createTelegramSendQueue();
  return {
    name: TELEGRAM_REPLY_LOOP_NAME,
    intervalMs: TELEGRAM_REPLY_INTERVAL_MS,
    async tick(): Promise<void> {
      await deliverPendingTelegramReplies({
        store: params.store,
        service: params.service,
        queue,
        sessionStore: params.sessionStore,
        logger: params.logger,
      });
    },
  };
}

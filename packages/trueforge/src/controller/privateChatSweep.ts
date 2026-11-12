import { TrueForge } from '@truefoundry/trueforge-sdk';
import type { Logger } from 'winston';
import configuration from '../config';
import { createTlsFetch, normalizeTlsUrl } from '../http/tls';
import type { ControlLoop } from './Controller';

/** A private chat is deleted within this long of its expiry. */
const PRIVATE_CHAT_SWEEP_INTERVAL_MS = 5 * 60_000;

const PRIVATE_CHAT_SWEEP_LOOP_NAME = 'private-chat-sweep';

/** Asks the server to delete expired private chats; returns how many it deleted. */
export type PrivateChatSweeper = () => Promise<number>;

/** HTTP handoff to `POST /api/internal/private-chats/sweep` (dedicated controller or standalone loopback). */
export function createHttpPrivateChatSweeper(): PrivateChatSweeper {
  const tls = {
    enabled: configuration.TRUEFORGE_MTLS_ENABLED,
    dir: configuration.TRUEFORGE_MTLS_CERTS_DIR,
  };
  const tlsFetch = createTlsFetch(tls);
  const client = new TrueForge({
    baseUrl: normalizeTlsUrl({ url: configuration.SERVER_URL, enabled: tls.enabled }),
    token: configuration.TRUEFORGE_API_KEY,
    timeoutInSeconds: 120,
    ...(tlsFetch === undefined ? {} : { fetch: tlsFetch }),
  });
  return async () => (await client.internal.privateChats.sweep()).deleted;
}

export function privateChatSweepLoop(params: { logger: Logger; sweep?: PrivateChatSweeper }): ControlLoop {
  const sweep = params.sweep ?? createHttpPrivateChatSweeper();
  return {
    name: PRIVATE_CHAT_SWEEP_LOOP_NAME,
    intervalMs: PRIVATE_CHAT_SWEEP_INTERVAL_MS,
    async tick(): Promise<void> {
      const deleted = await sweep();
      if (deleted > 0) {
        params.logger.info('Deleted expired private chats', { deleted });
      }
    },
  };
}

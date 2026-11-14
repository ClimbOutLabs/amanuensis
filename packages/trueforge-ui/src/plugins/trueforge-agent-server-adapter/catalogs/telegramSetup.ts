/**
 * Maps the Telegram port onto the server's settings Telegram routes (see accountSetupRequest.ts for
 * how the calls are made). The routes are browser-session only: they accept the browser session
 * cookie and refuse any bearer credential.
 */
import { z } from 'zod';
import type { TelegramAccountStatus, TelegramSetupPort } from '../../../server/telegramSetup.js';
import type { CreateTrueForgeClientOptions } from '../client.js';
import { createAccountSetupRequest } from './accountSetupRequest.js';

const TelegramAccountStatusWireSchema = z.object({
  available: z.boolean(),
  state: z.enum(['not_connected', 'awaiting_pairing', 'connected']),
  bot_name: z.string().nullable(),
  bot_username: z.string().nullable(),
  pairing_name: z.string().nullable(),
});

type TelegramAccountStatusWire = z.infer<typeof TelegramAccountStatusWireSchema>;

function toTelegramStatus(wire: TelegramAccountStatusWire): TelegramAccountStatus {
  return {
    available: wire.available,
    state: wire.state,
    botName: wire.bot_name,
    botUsername: wire.bot_username,
    pairingName: wire.pairing_name,
  };
}

const TELEGRAM_SETTINGS_PATH = '/api/v1/user/settings/telegram';

export function createTelegramSetupApi(options: CreateTrueForgeClientOptions = {}): TelegramSetupPort {
  const request = createAccountSetupRequest({
    options,
    path: TELEGRAM_SETTINGS_PATH,
    wireSchema: TelegramAccountStatusWireSchema,
    toStatus: toTelegramStatus,
  });
  const confirmRequest = createAccountSetupRequest({
    options,
    path: `${TELEGRAM_SETTINGS_PATH}/confirm`,
    wireSchema: TelegramAccountStatusWireSchema,
    toStatus: toTelegramStatus,
  });
  const cancelRequest = createAccountSetupRequest({
    options,
    path: `${TELEGRAM_SETTINGS_PATH}/cancel-pairing`,
    wireSchema: TelegramAccountStatusWireSchema,
    toStatus: toTelegramStatus,
  });

  return {
    getTelegramStatus: async () => request({ method: 'GET' }),
    connectTelegram: async (req: { token: string }) => request({ method: 'POST', body: { token: req.token } }),
    confirmTelegramPairing: async (req: { code: string }) =>
      confirmRequest({ method: 'POST', body: { code: req.code } }),
    cancelTelegramPairing: async () => cancelRequest({ method: 'POST', body: {} }),
    // A JSON body is sent on purpose: a bodiless state-changing call can be refused as
    // not-from-Aman when the instance is reached through its proxy address.
    removeTelegram: async () => request({ method: 'DELETE', body: {} }),
  };
}

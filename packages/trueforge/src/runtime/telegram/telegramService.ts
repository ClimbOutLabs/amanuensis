import { randomBytes } from 'node:crypto';

import type { CreatedBySubject } from '@truefoundry/trueforge-core/agent-session';
import type { Logger } from 'winston';

import type { ITelegramStore, TelegramConnection, TelegramOwner } from '../../db/telegramStore';
import type { TelegramAccountStatus } from '../../schemas/telegram';
import { createTelegramClient, TelegramApiError, type TelegramClient } from './telegramClient';

/**
 * What the Settings Telegram card does: connect a bot, show where pairing stands, confirm a
 * pairing, cancel a waiting pairing, and disconnect. The bot token is checked with Telegram
 * before anything is saved, and is never returned: the status is built only from the bot's name
 * and the pairing. The pairing code is never returned either: the bot shows it only in Telegram,
 * so the code a person types here proves they hold the Telegram chat. The status names who is
 * waiting to pair instead, so a stranger who messaged the bot first shows their own name and
 * can be cancelled rather than paired by mistake.
 */

/** How long a pairing code stays good. Long enough to walk to the phone, short enough to mean something. */
export const TELEGRAM_PAIRING_TTL_MS = 15 * 60 * 1000;

/** A settings failure a person can act on. The message always names the one thing to do next. */
export class TelegramSettingsError extends Error {
  readonly status: 400 | 502;
  /** The failure kind the wire carries: telegram_refused, telegram_unreachable or pairing. */
  readonly failure: string;

  constructor(input: { message: string; status: 400 | 502; failure?: string; cause?: unknown }) {
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause });
    this.name = 'TelegramSettingsError';
    this.status = input.status;
    this.failure = input.failure ?? (input.status === 502 ? 'telegram_unreachable' : 'telegram_refused');
  }
}

export interface TelegramService {
  status(owner: TelegramOwner): Promise<TelegramAccountStatus>;
  /** Checks the token with Telegram first; a refused or unreachable check saves nothing. */
  connect(
    input: TelegramOwner & { token: string; created_by_subject: CreatedBySubject },
  ): Promise<TelegramAccountStatus>;
  /** Pairs the person who sent /start, when the typed code matches the one the bot sent them. */
  confirmPairing(input: TelegramOwner & { code: string }): Promise<TelegramAccountStatus>;
  /** Drops the pairing that is waiting, without pairing anyone, so a stranger's /start can be refused. */
  cancelPairing(owner: TelegramOwner): Promise<TelegramAccountStatus>;
  /** Removes the bot and its token for good. */
  disconnect(owner: TelegramOwner): Promise<TelegramAccountStatus>;
  /** A client for a stored connection, for the parts that talk to Telegram outside Settings. */
  clientFor(connection: TelegramConnection): TelegramClient;
}

function statusOf(connection: TelegramConnection | undefined, now: Date): TelegramAccountStatus {
  if (connection === undefined) {
    return { available: true, state: 'not_connected', bot_name: null, bot_username: null, pairing_name: null };
  }
  const paired = connection.paired_telegram_user_id !== null;
  const codeLive =
    connection.pairing_code !== null &&
    connection.pairing_expires_at !== null &&
    new Date(connection.pairing_expires_at).getTime() > now.getTime();
  return {
    available: true,
    state: paired ? 'connected' : 'awaiting_pairing',
    bot_name: connection.bot_name,
    bot_username: connection.bot_username,
    pairing_name: !paired && codeLive ? connection.pairing_display_name : null,
  };
}

export function createTelegramService({
  store,
  createClient = token => createTelegramClient({ token }),
  publicBaseUrl,
  now = () => new Date(),
  newSecret = () => randomBytes(24).toString('base64url'),
  logger,
}: {
  store: ITelegramStore;
  createClient?: (token: string) => TelegramClient;
  /** The address people reach this instance at; a webhook is used only when it is https. */
  publicBaseUrl: string;
  now?: () => Date;
  newSecret?: () => string;
  /** Hears about a webhook that could not be set, which the Settings card does not show today. */
  logger?: Logger;
}): TelegramService {
  async function status(owner: TelegramOwner): Promise<TelegramAccountStatus> {
    return statusOf(await store.getConnection(owner), now());
  }

  return {
    status,
    clientFor: connection => createClient(connection.bot_token),

    async connect(input) {
      const token = input.token.trim();
      if (token === '') {
        throw new TelegramSettingsError({
          message: 'Paste the bot token from BotFather first, then press Connect again.',
          status: 400,
        });
      }
      const client = createClient(token);
      let bot: Awaited<ReturnType<TelegramClient['getMe']>>;
      try {
        bot = await client.getMe();
      } catch (error) {
        if (error instanceof TelegramApiError && error.refused) {
          throw new TelegramSettingsError({
            message: 'Telegram refused that token. Copy the token from BotFather again and paste it here.',
            status: 400,
            cause: error,
          });
        }
        throw new TelegramSettingsError({
          message: 'Telegram could not be reached. Check your internet connection, then try again.',
          status: 502,
          cause: error,
        });
      }
      // A webhook is used only when this instance has a public https address; anything else
      // polls. A webhook that cannot be set is not fatal: polling reaches the same updates.
      // The fallback is silent on the Settings card today, so it is at least logged here.
      let transport: 'polling' | 'webhook' = 'polling';
      let webhookSecret: string | null = null;
      if (publicBaseUrl.startsWith('https://')) {
        const secret = newSecret();
        try {
          await client.setWebhook({
            url: `${publicBaseUrl.replace(/\/+$/, '')}/api/telegram/webhook`,
            secret_token: secret,
          });
          transport = 'webhook';
          webhookSecret = secret;
        } catch (error) {
          logger?.warn('The Telegram webhook could not be set, so this bot polls for updates instead', {
            error: error instanceof Error ? error.message : String(error),
          });
          transport = 'polling';
          webhookSecret = null;
        }
      }
      if (transport === 'polling') {
        // A token that once had a webhook would never deliver to polling until it is removed.
        await client.deleteWebhook().catch(() => undefined);
      }
      const saved = await store.saveConnection({
        tenant_id: input.tenant_id,
        created_by: input.created_by,
        created_by_subject: input.created_by_subject,
        bot_token: token,
        bot_id: bot.id,
        bot_name: bot.name,
        bot_username: bot.username,
        transport,
        webhook_secret: webhookSecret,
        now: now(),
      });
      return statusOf(saved, now());
    },

    async confirmPairing(input) {
      const owner = { tenant_id: input.tenant_id, created_by: input.created_by };
      const connection = await store.getConnection(owner);
      if (connection === undefined) {
        throw new TelegramSettingsError({
          message: 'Connect your bot first, then confirm the pairing.',
          status: 400,
        });
      }
      if (connection.paired_telegram_user_id !== null) {
        return statusOf(connection, now());
      }
      if (connection.pairing_code === null || connection.pairing_expires_at === null) {
        throw new TelegramSettingsError({
          message:
            'No code is waiting. Open Telegram, message your bot, send /start, then enter the code it sends you.',
          status: 400,
          failure: 'pairing',
        });
      }
      if (new Date(connection.pairing_expires_at).getTime() <= now().getTime()) {
        await store.clearPairing({ ...owner, now: now() });
        throw new TelegramSettingsError({
          message: 'That code has expired. Send /start to your bot again, then enter the new code it sends you.',
          status: 400,
          failure: 'pairing',
        });
      }
      if (input.code.trim() !== connection.pairing_code) {
        throw new TelegramSettingsError({
          message: 'That code does not match the one your bot sent. Check the code in Telegram and try again.',
          status: 400,
          failure: 'pairing',
        });
      }
      // The store pairs whoever is waiting under this code in one conditional write. A /start
      // that landed after the read above replaced the code, so the write matches nothing and
      // the pairing waiting now is not the one this code was sent to.
      const paired = await store.confirmPairing({ ...owner, code: connection.pairing_code, now: now() });
      if (!paired) {
        throw new TelegramSettingsError({
          message:
            'That code is no longer the waiting one. Check who is waiting in Settings, then enter the newest code your bot sent.',
          status: 400,
          failure: 'pairing',
        });
      }
      return status(owner);
    },

    async cancelPairing(input) {
      const owner = { tenant_id: input.tenant_id, created_by: input.created_by };
      const connection = await store.getConnection(owner);
      if (connection === undefined) {
        throw new TelegramSettingsError({
          message: 'Connect your bot first, then cancel the pairing.',
          status: 400,
          failure: 'pairing',
        });
      }
      await store.clearPairing({ ...owner, now: now() });
      return status(owner);
    },

    async disconnect(owner) {
      const connection = await store.getConnection(owner);
      if (connection?.transport === 'webhook') {
        await createClient(connection.bot_token)
          .deleteWebhook()
          .catch(() => undefined);
      }
      await store.deleteConnection(owner);
      return status(owner);
    },
  };
}

/** A fraction in [0, 1) from the crypto source, the same source the webhook secret is drawn from. */
function secureRandomFraction(): number {
  return randomBytes(4).readUInt32BE(0) / 2 ** 32;
}

/** A fresh six-digit pairing code. A code is a credential, so its digits come from the crypto source. */
export function newPairingCode(random: () => number = secureRandomFraction): string {
  return String(Math.floor(random() * 1_000_000)).padStart(6, '0');
}

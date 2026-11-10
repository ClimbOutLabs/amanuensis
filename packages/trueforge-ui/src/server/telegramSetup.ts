/**
 * The Telegram port the Harness adds on top of the runtime's connector port.
 * The wire types are hand-written here so this card keeps its own mapping of the server's
 * snake_case fields; the adapter calls the settings Telegram endpoints directly.
 */

/** Where the Telegram connection stands: no bot yet, a bot waiting to be paired, or paired and live. */
export type TelegramConnectionState = 'not_connected' | 'awaiting_pairing' | 'connected';

/** The Telegram card's state. The bot token is never part of it: the field is write-only. */
export interface TelegramAccountStatus {
  /** Whether this instance offers Telegram at all; when false, no card is shown. */
  available: boolean;
  state: TelegramConnectionState;
  /** The bot's name, as Telegram shows it; null when no bot is connected. */
  botName: string | null;
  /** The bot's username, without the @; null when no bot is connected. */
  botUsername: string | null;
  /**
   * The name Telegram shows for the person waiting to pair; null when nobody waits. The
   * pairing code itself is never part of the status: the bot shows it only in Telegram, so
   * typing it here proves the person holds that chat.
   */
  pairingName: string | null;
}

/** Operations behind Settings, Connectors, Telegram. */
export interface TelegramSetupPort {
  getTelegramStatus(): Promise<TelegramAccountStatus>;
  /** Checks the token with Telegram first; a refused or unreachable check saves nothing and the error says why. */
  connectTelegram(req: { token: string }): Promise<TelegramAccountStatus>;
  /** Pairs the person who sent /start, when the code matches the one the bot sent them. */
  confirmTelegramPairing(req: { code: string }): Promise<TelegramAccountStatus>;
  /** Drops the pairing that is waiting, without pairing anyone, so a stranger's /start can be refused. */
  cancelTelegramPairing(): Promise<TelegramAccountStatus>;
  /** Removes the bot, its token and its pairing for good. */
  removeTelegram(): Promise<TelegramAccountStatus>;
}

/** Whether a catalog implements the Telegram port; another host's catalog may not. */
export function hasTelegramSetup(catalog: object): catalog is TelegramSetupPort {
  return typeof Reflect.get(catalog, 'getTelegramStatus') === 'function';
}

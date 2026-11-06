/**
 * The Telegram port the Harness adds on top of the runtime's connector port.
 * Hand-written wire types: the generated SDK has no Telegram settings routes yet, so the
 * adapter calls the server endpoints directly and maps their snake_case fields here.
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
  /** The six-digit code the bot sent after /start, shown so it can be checked; null when none waits. */
  pairingCode: string | null;
}

/** Operations behind Settings, Connectors, Telegram. */
export interface TelegramSetupPort {
  getTelegramStatus(): Promise<TelegramAccountStatus>;
  /** Checks the token with Telegram first; a refused or unreachable check saves nothing and the error says why. */
  connectTelegram(req: { token: string }): Promise<TelegramAccountStatus>;
  /** Pairs the person who sent /start, when the code matches the one the bot sent them. */
  confirmTelegramPairing(req: { code: string }): Promise<TelegramAccountStatus>;
  /** Removes the bot, its token and its pairing for good. */
  removeTelegram(): Promise<TelegramAccountStatus>;
}

/** Whether a catalog implements the Telegram port; another host's catalog may not. */
export function hasTelegramSetup(catalog: object): catalog is TelegramSetupPort {
  return typeof Reflect.get(catalog, 'getTelegramStatus') === 'function';
}

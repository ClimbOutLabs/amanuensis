import { timingSafeEqual } from 'node:crypto';

import type {
  AddTelegramPendingApprovalInput,
  AddTelegramPendingReplyInput,
  ITelegramStore,
  SaveTelegramConnectionInput,
  StartTelegramPairingInput,
  TelegramConnection,
  TelegramOwner,
  TelegramPendingApproval,
  TelegramPendingReply,
} from '../db/telegramStore';
import { isEncryptedSecret, type SecretContext } from './secretCipher';
import type { SecretVault } from './secretVault';

type SecretField = 'bot_token' | 'webhook_secret';

function context({ owner, field }: { owner: TelegramOwner; field: SecretField }): SecretContext {
  return { table: 'telegram_connection', primary_key: JSON.stringify([owner.tenant_id, owner.created_by]), field };
}

function sameSecret({ left, right }: { left: string; right: string }): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Keeps the Telegram bot token and webhook secret encrypted in the wrapped store. Callers pass
 * and get the real values. A value saved before encryption is read as it is until it is
 * encrypted in place.
 */
export class EncryptedTelegramStore implements ITelegramStore {
  readonly #store: ITelegramStore;
  readonly #vault: SecretVault;

  constructor({ store, vault }: { store: ITelegramStore; vault: SecretVault }) {
    this.#store = store;
    this.#vault = vault;
  }

  async getConnection(owner: TelegramOwner): Promise<TelegramConnection | undefined> {
    return this.#openIfFound(await this.#store.getConnection(owner));
  }

  async getConnectionById(input: { id: string }): Promise<TelegramConnection | undefined> {
    return this.#openIfFound(await this.#store.getConnectionById(input));
  }

  /** The saved secret is encrypted, so it cannot be looked up; each connection's is decrypted and compared. */
  async getConnectionByWebhookSecret(input: { webhook_secret: string }): Promise<TelegramConnection | undefined> {
    return (await this.listConnections()).find(
      connection =>
        connection.webhook_secret !== null &&
        sameSecret({ left: connection.webhook_secret, right: input.webhook_secret }),
    );
  }

  async listConnections(): Promise<TelegramConnection[]> {
    return (await this.#store.listConnections()).map(connection => this.#open(connection));
  }

  async saveConnection(input: SaveTelegramConnectionInput): Promise<TelegramConnection> {
    const seal = ({ field, value }: { field: SecretField; value: string }): string =>
      this.#vault.encrypt({ plaintext: value, context: context({ owner: input, field }) });
    return this.#open(
      await this.#store.saveConnection({
        ...input,
        bot_token: seal({ field: 'bot_token', value: input.bot_token }),
        webhook_secret:
          input.webhook_secret === null ? null : seal({ field: 'webhook_secret', value: input.webhook_secret }),
      }),
    );
  }

  deleteConnection(owner: TelegramOwner): Promise<boolean> {
    return this.#store.deleteConnection(owner);
  }

  startPairing(input: StartTelegramPairingInput): Promise<void> {
    return this.#store.startPairing(input);
  }

  confirmPairing(input: TelegramOwner & { code: string; now?: Date }): Promise<boolean> {
    return this.#store.confirmPairing(input);
  }

  clearPairing(owner: TelegramOwner & { now?: Date }): Promise<void> {
    return this.#store.clearPairing(owner);
  }

  claimUpdate(input: { connection_id: string; update_id: string; now?: Date }): Promise<boolean> {
    return this.#store.claimUpdate(input);
  }

  setPollOffset(input: TelegramOwner & { poll_offset: string; now?: Date }): Promise<void> {
    return this.#store.setPollOffset(input);
  }

  setSessionId(input: TelegramOwner & { session_id: string; now?: Date }): Promise<void> {
    return this.#store.setSessionId(input);
  }

  addPendingReply(input: AddTelegramPendingReplyInput): Promise<void> {
    return this.#store.addPendingReply(input);
  }

  listPendingReplies(input: { limit: number }): Promise<TelegramPendingReply[]> {
    return this.#store.listPendingReplies(input);
  }

  deletePendingReply(input: { id: string }): Promise<void> {
    return this.#store.deletePendingReply(input);
  }

  addPendingApproval(input: AddTelegramPendingApprovalInput): Promise<TelegramPendingApproval> {
    return this.#store.addPendingApproval(input);
  }

  getPendingApproval(input: { id: string }): Promise<TelegramPendingApproval | undefined> {
    return this.#store.getPendingApproval(input);
  }

  deletePendingApproval(input: { id: string }): Promise<void> {
    return this.#store.deletePendingApproval(input);
  }

  #open(connection: TelegramConnection): TelegramConnection {
    const open = ({ field, value }: { field: SecretField; value: string }): string =>
      isEncryptedSecret(value) ? this.#vault.decrypt({ value, context: context({ owner: connection, field }) }) : value;
    return {
      ...connection,
      bot_token: open({ field: 'bot_token', value: connection.bot_token }),
      webhook_secret:
        connection.webhook_secret === null ? null : open({ field: 'webhook_secret', value: connection.webhook_secret }),
    };
  }

  #openIfFound(connection: TelegramConnection | undefined): TelegramConnection | undefined {
    return connection === undefined ? undefined : this.#open(connection);
  }
}

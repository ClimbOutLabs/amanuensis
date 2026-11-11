import type {
  ITelegramStore,
  TelegramConnection,
  TelegramOwner,
  TelegramPendingApproval,
  TelegramPendingReply,
} from '../../src/db/telegramStore';
import type { TelegramClient, TelegramInlineButton } from '../../src/runtime/telegram/telegramClient';
import type { TelegramSendQueue } from '../../src/runtime/telegram/telegramSendQueue';
import type { TelegramUpdate } from '../../src/schemas/telegram';

/**
 * In-memory Telegram store and client for unit tests: no database, no network. The store honours the
 * same shapes the real store returns, so service and channel tests exercise the real logic.
 */

export const TELEGRAM_TEST_OWNER: TelegramOwner = { tenant_id: 'local', created_by: 'test-user' };

export type FakeTelegramConnectionOverrides = Partial<TelegramConnection>;

export function fakeTelegramConnection(overrides: FakeTelegramConnectionOverrides = {}): TelegramConnection {
  return {
    id: 'conn-1',
    tenant_id: 'local',
    created_by: 'test-user',
    created_by_subject: { subject_id: 'test-user', subject_type: 'owner', subject_display_name: 'Test User' },
    bot_token: 'token-123',
    bot_id: '4242',
    bot_name: 'Test Bot',
    bot_username: 'test_bot',
    paired_telegram_user_id: null,
    paired_chat_id: null,
    pairing_code: null,
    pairing_expires_at: null,
    pairing_telegram_user_id: null,
    pairing_chat_id: null,
    pairing_display_name: null,
    last_update_id: null,
    poll_offset: null,
    transport: 'polling',
    webhook_secret: null,
    session_id: null,
    created_at: '2026-11-06T00:00:00.000Z',
    updated_at: '2026-11-06T00:00:00.000Z',
    ...overrides,
  };
}

/** A connection that is paired with Telegram user 555 in chat 777. */
export function fakePairedConnection(overrides: FakeTelegramConnectionOverrides = {}): TelegramConnection {
  return fakeTelegramConnection({
    paired_telegram_user_id: '555',
    paired_chat_id: '777',
    ...overrides,
  });
}

function owns(owner: TelegramOwner, connection: TelegramConnection): boolean {
  return owner.tenant_id === connection.tenant_id && owner.created_by === connection.created_by;
}

export class InMemoryTelegramStore implements ITelegramStore {
  connection: TelegramConnection | null = null;
  pendingReplies: TelegramPendingReply[] = [];
  pendingApprovals: TelegramPendingApproval[] = [];
  private replySeq = 0;
  private approvalSeq = 0;

  getConnection(owner: TelegramOwner): Promise<TelegramConnection | undefined> {
    return Promise.resolve(this.connection !== null && owns(owner, this.connection) ? this.connection : undefined);
  }

  getConnectionById(input: { id: string }): Promise<TelegramConnection | undefined> {
    return Promise.resolve(this.connection?.id === input.id ? this.connection : undefined);
  }

  getConnectionByWebhookSecret(input: { webhook_secret: string }): Promise<TelegramConnection | undefined> {
    return Promise.resolve(
      this.connection !== null && this.connection.webhook_secret === input.webhook_secret ? this.connection : undefined,
    );
  }

  listConnections(): Promise<TelegramConnection[]> {
    return Promise.resolve(this.connection === null ? [] : [this.connection]);
  }

  saveConnection(input: Parameters<ITelegramStore['saveConnection']>[0]): Promise<TelegramConnection> {
    this.connection = fakeTelegramConnection({
      tenant_id: input.tenant_id,
      created_by: input.created_by,
      created_by_subject: input.created_by_subject,
      bot_token: input.bot_token,
      bot_id: input.bot_id,
      bot_name: input.bot_name,
      bot_username: input.bot_username,
      transport: input.transport,
      webhook_secret: input.webhook_secret,
    });
    this.pendingReplies = [];
    this.pendingApprovals = [];
    return Promise.resolve(this.connection);
  }

  deleteConnection(owner: TelegramOwner): Promise<boolean> {
    if (this.connection !== null && owns(owner, this.connection)) {
      this.connection = null;
      this.pendingReplies = [];
      this.pendingApprovals = [];
      return Promise.resolve(true);
    }
    return Promise.resolve(false);
  }

  startPairing(input: Parameters<ITelegramStore['startPairing']>[0]): Promise<void> {
    if (this.connection !== null && owns(input, this.connection)) {
      this.connection = {
        ...this.connection,
        pairing_code: input.code,
        pairing_expires_at: input.expires_at.toISOString(),
        pairing_telegram_user_id: input.telegram_user_id,
        pairing_chat_id: input.chat_id,
        pairing_display_name: input.display_name,
      };
    }
    return Promise.resolve();
  }

  confirmPairing(input: Parameters<ITelegramStore['confirmPairing']>[0]): Promise<boolean> {
    if (
      this.connection !== null &&
      owns(input, this.connection) &&
      this.connection.pairing_code === input.code &&
      this.connection.pairing_telegram_user_id !== null &&
      this.connection.pairing_chat_id !== null
    ) {
      this.connection = {
        ...this.connection,
        paired_telegram_user_id: this.connection.pairing_telegram_user_id,
        paired_chat_id: this.connection.pairing_chat_id,
        pairing_code: null,
        pairing_expires_at: null,
        pairing_telegram_user_id: null,
        pairing_chat_id: null,
        pairing_display_name: null,
      };
      return Promise.resolve(true);
    }
    return Promise.resolve(false);
  }

  clearPairing(owner: TelegramOwner): Promise<void> {
    if (this.connection !== null && owns(owner, this.connection)) {
      this.connection = {
        ...this.connection,
        pairing_code: null,
        pairing_expires_at: null,
        pairing_telegram_user_id: null,
        pairing_chat_id: null,
        pairing_display_name: null,
      };
    }
    return Promise.resolve();
  }

  claimUpdate(input: Parameters<ITelegramStore['claimUpdate']>[0]): Promise<boolean> {
    if (this.connection?.id !== input.connection_id) {
      return Promise.resolve(false);
    }
    const last = this.connection.last_update_id;
    if (last !== null && Number(input.update_id) <= Number(last)) {
      return Promise.resolve(false);
    }
    this.connection = { ...this.connection, last_update_id: input.update_id };
    return Promise.resolve(true);
  }

  setPollOffset(input: Parameters<ITelegramStore['setPollOffset']>[0]): Promise<void> {
    if (this.connection !== null && owns(input, this.connection)) {
      this.connection = { ...this.connection, poll_offset: input.poll_offset };
    }
    return Promise.resolve();
  }

  setSessionId(input: Parameters<ITelegramStore['setSessionId']>[0]): Promise<void> {
    if (this.connection !== null && owns(input, this.connection)) {
      this.connection = { ...this.connection, session_id: input.session_id };
    }
    return Promise.resolve();
  }

  addPendingReply(input: Parameters<ITelegramStore['addPendingReply']>[0]): Promise<void> {
    if (!this.pendingReplies.some(row => row.turn_id === input.turn_id)) {
      this.replySeq += 1;
      this.pendingReplies.push({
        id: `reply-${String(this.replySeq)}`,
        tenant_id: input.tenant_id,
        created_by: input.created_by,
        connection_id: input.connection_id,
        chat_id: input.chat_id,
        session_id: input.session_id,
        turn_id: input.turn_id,
        created_at: '2026-11-06T00:00:00.000Z',
      });
    }
    return Promise.resolve();
  }

  listPendingReplies(input: { limit: number }): Promise<TelegramPendingReply[]> {
    return Promise.resolve(this.pendingReplies.slice(0, input.limit));
  }

  deletePendingReply(input: { id: string }): Promise<void> {
    this.pendingReplies = this.pendingReplies.filter(row => row.id !== input.id);
    return Promise.resolve();
  }

  addPendingApproval(input: Parameters<ITelegramStore['addPendingApproval']>[0]): Promise<TelegramPendingApproval> {
    this.approvalSeq += 1;
    const row: TelegramPendingApproval = {
      id: `approval-${String(this.approvalSeq)}`,
      tenant_id: input.tenant_id,
      created_by: input.created_by,
      connection_id: input.connection_id,
      chat_id: input.chat_id,
      session_id: input.session_id,
      turn_id: input.turn_id,
      thread_id: input.thread_id,
      tool_call_id: input.tool_call_id,
      prompt: input.prompt,
      expires_at: input.expires_at,
      created_at: '2026-11-06T00:00:00.000Z',
    };
    this.pendingApprovals.push(row);
    return Promise.resolve(row);
  }

  getPendingApproval(input: { id: string }): Promise<TelegramPendingApproval | undefined> {
    return Promise.resolve(this.pendingApprovals.find(row => row.id === input.id));
  }

  deletePendingApproval(input: { id: string }): Promise<void> {
    this.pendingApprovals = this.pendingApprovals.filter(row => row.id !== input.id);
    return Promise.resolve();
  }
}

export interface SentTelegramMessage {
  chat_id: string;
  text: string;
  inline_buttons: readonly (readonly TelegramInlineButton[])[] | undefined;
}

/** A Telegram client that records sends and answers callbacks; getMe and downloads are set by the test. */
export class FakeTelegramClient implements TelegramClient {
  sent: SentTelegramMessage[] = [];
  answeredCallbacks: { callback_query_id: string; text: string | undefined }[] = [];
  updates: Parameters<TelegramClient['getUpdates']>[0]['offset'][] = [];
  webhookUrls: string[] = [];
  deleteWebhookCalls = 0;
  fileBytes = new TextEncoder().encode('fake-file-bytes');
  failSend = false;

  getMe(): Promise<{ id: string; name: string; username: string | null }> {
    return Promise.resolve({ id: '4242', name: 'Test Bot', username: 'test_bot' });
  }

  getUpdates(input: { offset: string | null }): Promise<TelegramUpdate[]> {
    this.updates.push(input.offset);
    return Promise.resolve([]);
  }

  sendMessage(input: {
    chat_id: string;
    text: string;
    inline_buttons?: readonly (readonly TelegramInlineButton[])[] | undefined;
  }): Promise<{ message_id: number }> {
    if (this.failSend) {
      return Promise.reject(new Error('send failed'));
    }
    this.sent.push({ chat_id: input.chat_id, text: input.text, inline_buttons: input.inline_buttons });
    return Promise.resolve({ message_id: this.sent.length });
  }

  answerCallbackQuery(input: { callback_query_id: string; text?: string | undefined }): Promise<void> {
    this.answeredCallbacks.push({ callback_query_id: input.callback_query_id, text: input.text });
    return Promise.resolve();
  }

  downloadFile(): Promise<Uint8Array> {
    return Promise.resolve(this.fileBytes);
  }

  setWebhook(input: { url: string }): Promise<void> {
    this.webhookUrls.push(input.url);
    return Promise.resolve();
  }

  deleteWebhook(): Promise<void> {
    this.deleteWebhookCalls += 1;
    return Promise.resolve();
  }
}

/** A send queue with no pacing, for tests. */
export const immediateQueue: TelegramSendQueue = {
  enqueue: <T>(work: () => Promise<T>): Promise<T> => work(),
};

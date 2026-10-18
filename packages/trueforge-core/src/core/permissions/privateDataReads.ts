/**
 * Which chats have read something private (a secrets file, a key). Once a chat has, the search
 * provider stops running silently there, so what was read cannot ride out in a later query.
 */

export interface PrivateDataReadKey {
  tenant_id: string;
  conversation_id: string;
}

export interface PrivateDataReadStore {
  markPrivateDataRead(key: PrivateDataReadKey): void;
  hasPrivateDataRead(key: PrivateDataReadKey): boolean;
}

/** Keeps memory bounded on a long-lived server; the oldest chats are forgotten first. */
const MAX_REMEMBERED_CHATS = 50_000;

function chatId(key: PrivateDataReadKey): string {
  return JSON.stringify([key.tenant_id, key.conversation_id]);
}

/** Process-local: a restart forgets, which only makes the next search quiet again after a fresh read. */
export class InMemoryPrivateDataReadStore implements PrivateDataReadStore {
  private readonly chats = new Set<string>();

  markPrivateDataRead(key: PrivateDataReadKey): void {
    this.chats.add(chatId(key));
    if (this.chats.size > MAX_REMEMBERED_CHATS) {
      const oldest = this.chats.values().next();
      if (!oldest.done) {
        this.chats.delete(oldest.value);
      }
    }
  }

  hasPrivateDataRead(key: PrivateDataReadKey): boolean {
    return this.chats.has(chatId(key));
  }
}

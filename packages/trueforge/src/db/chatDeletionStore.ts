/** Deleting a chat for real, and the token counts a deleted chat leaves behind. */

export interface DeleteChatInput {
  tenant_id: string;
  session_id: string;
  /** When set, the chat is deleted only if it is private and its expiry is at or before this time. */
  expired_by: Date | undefined;
}

/** One model-usage event of a deleted chat: counts and cost only. */
export interface DeletedChatModelUsageRecord {
  event_id: string;
  model_id: string;
  display_name: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number | null;
  /** ISO-8601 UTC instant of the original event. */
  created_at: string;
}

export interface ListDeletedChatModelUsageInput {
  tenant_id: string;
  created_by_subject_id: string;
  /** Inclusive. */
  from: Date;
  /** Exclusive. */
  to: Date;
}

export interface IChatDeletionStore {
  /**
   * In one transaction: keeps the chat's model-usage counts (no session id, no words), deletes its
   * turn artifacts and any blob no other artifact uses, then deletes the chat, which removes its
   * turns, events, thread context and pictures with it. Returns false when nothing was deleted.
   */
  deleteChat(input: DeleteChatInput): Promise<boolean>;
  /** Removes turn artifacts whose chat no longer exists, and the blobs only they used. Returns rows removed. */
  deleteOrphanedArtifacts(): Promise<number>;
  /** Deletes every private chat, as `deleteChat` does, whatever its expiry. Returns chats deleted. */
  deletePrivateChats(): Promise<number>;
  /** A person's kept usage counts from deleted chats in `[from, to)`, oldest first. */
  listDeletedChatModelUsage(input: ListDeletedChatModelUsageInput): Promise<DeletedChatModelUsageRecord[]>;
}

/**
 * Re-encoded images shown in chat, kept per user and per chat. Rows go with their chat (session
 * foreign key, cascade), expire after the retention period, and each user's total is capped with the
 * oldest images removed first.
 */

/** How an image reached the page: local file, remote image loaded without asking, or after a card. */
export type ChatImageOrigin = 'local' | 'remote_silent' | 'remote_approved';

export interface ChatImageRecord {
  tenant_id: string;
  created_by: string;
  session_id: string;
  turn_id: string;
  image_id: string;
  /** Stable key of the source within the chat, so asking twice reuses one stored image. */
  source_key: string;
  origin: ChatImageOrigin;
  mime: string;
  width: number;
  height: number;
  size: number;
  /** ISO-8601 UTC instant. */
  created_at: string;
}

export interface ChatImageWithData extends ChatImageRecord {
  data: Buffer;
}

export interface PutChatImageInput {
  tenant_id: string;
  created_by: string;
  session_id: string;
  turn_id: string;
  image_id: string;
  source_key: string;
  origin: ChatImageOrigin;
  mime: string;
  width: number;
  height: number;
  data: Buffer;
  /** Largest total this user may hold; older images are removed until the new total fits. */
  user_max_bytes: number;
}

export interface IChatImageStore<TTransaction = never> {
  /**
   * Stores the image, or returns the image already stored for the same source in this chat. Then
   * removes the user's oldest images, never the new one, until their total fits `user_max_bytes`.
   */
  putImage(input: PutChatImageInput, transaction?: TTransaction): Promise<ChatImageRecord>;
  /** The image with its bytes, or undefined when it is not in this chat. */
  getImage(
    input: { tenant_id: string; session_id: string; image_id: string },
    transaction?: TTransaction,
  ): Promise<ChatImageWithData | undefined>;
  /** The image already stored for a source in this chat, without its bytes. */
  findBySource(
    input: { tenant_id: string; session_id: string; source_key: string },
    transaction?: TTransaction,
  ): Promise<ChatImageRecord | undefined>;
  /** Images of one origin stored for a turn, for the per-turn silent limit. */
  countTurnImages(
    input: { tenant_id: string; session_id: string; turn_id: string; origin: ChatImageOrigin },
    transaction?: TTransaction,
  ): Promise<number>;
  /** Retention sweep across all tenants; returns the number of images removed. */
  deleteImagesOlderThan(input: { older_than: string }, transaction?: TTransaction): Promise<number>;
}

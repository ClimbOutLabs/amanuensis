/** Where an item in the feed leads. */
export type DeliveryLink =
  | { type: 'chat'; sessionId: string }
  | { type: 'approval'; sessionId: string; approvalId: string }
  | { type: 'space'; spaceId: string };

/** One thing the server sent the person, as the app draws it. The server owns the wire shape. */
export type DeliveryItem = {
  id: string;
  /** Plain text so a kind added later still shows, without an app update. */
  kind: string;
  text: string;
  reason: string;
  link: DeliveryLink | null;
  /** ISO 8601 UTC. */
  createdAt: string;
  /** ISO 8601 UTC, or null while unread. */
  seenAt: string | null;
};

export type DeliveryPage = { items: DeliveryItem[]; nextPageToken: string | undefined };

/** What a browser hands over when it turns notices on. */
export type PushDevice = { endpoint: string; p256dh: string; auth: string; label: string };

/** The feed and the push devices, served by the host. */
export type DeliveriesApi = {
  /** Where the service worker lives under the app's public path, and the part of the app it covers. */
  pushWorker: { url: string; scope: string };
  list(input: { limit: number; pageToken?: string }): Promise<DeliveryPage>;
  unreadCount(): Promise<number>;
  /** Marks items seen on every device. Resolves to the unread count afterwards. */
  markSeen(ids: readonly string[]): Promise<number>;
  /** Marks every unread item seen on every device, loaded or not. Resolves to the unread count afterwards. */
  markAllSeen(): Promise<number>;
  /** Resolves to null when the item is not the signed-in person's. */
  get(id: string): Promise<DeliveryItem | null>;
  /** The key a browser needs to turn notices on, or null while push is off on the server. */
  pushPublicKey(): Promise<string | null>;
  /** Resolves to `taken` when this address already gets another account's notices; a fresh subscription is needed. */
  savePushDevice(device: PushDevice): Promise<'saved' | 'taken'>;
  removePushDevice(endpoint: string): Promise<void>;
  /** Whether the server still sends notices to this address. A device drops off when newer ones replace it or it goes away. */
  pushDeviceSaved(endpoint: string): Promise<boolean>;
};

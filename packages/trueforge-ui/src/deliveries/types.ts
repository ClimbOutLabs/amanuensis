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

/** The kinds of event the assistant watches for, in the order Reach me lists them. */
export const NOTICING_KINDS = ['mail_always', 'calendar_clash', 'travel', 'bill_due', 'approval_waiting'] as const;

export type NoticingKind = (typeof NOTICING_KINDS)[number];

export type ReachSender = {
  address: string;
  name: string | null;
  /** Whether the person typed this sender or accepted it from a memory suggestion. */
  source: 'settings' | 'memory';
  /** Kept as the server wrote it, so saving the list does not change when a sender was added. */
  addedAt: string;
};

export type ReachSettings = {
  /** Whether the assistant checks mail, the calendar and waiting approvals in the background. */
  noticingOn: boolean;
  textsOn: boolean;
  callsOn: boolean;
  alwaysImportant: ReachSender[];
  dismissedSuggestions: string[];
  callKinds: NoticingKind[];
  callForUrgentReminders: boolean;
  quietHours: { enabled: boolean; start: string; end: string };
  timezone: string;
  maxNudgesPerDay: number;
  minHoursBetweenCalls: number;
  travelLeadMinutes: number;
  approvalWaitMinutes: number;
};

export type ReachChannelState = {
  available: boolean;
  note: string;
  /** Set when the channel works but has a problem to fix, in plain words with what to do. */
  problem: string | null;
};

export type ReachView = {
  settings: ReachSettings;
  /** False until the person saves once. While false, the settings are the quiet defaults. */
  saved: boolean;
  availability: { texts: ReachChannelState; calls: ReachChannelState };
  /** The highest level each kind of event can ever reach, so only kinds that can call offer the tick. */
  maxLevels: Partial<Record<NoticingKind, 'note' | 'nudge' | 'call'>>;
  /** Set once mail has gone unchecked for about an hour: since when, and what to do about it. */
  mailProblem: { since: string; kind: 'too_slow' | 'google_sign_in' | 'email_password' | 'other' } | null;
  /** Set once the calendar has gone unchecked for about an hour. */
  calendarProblem: { since: string; kind: 'google_sign_in' | 'other' } | null;
  /** Where mail is read from, or null until it has been checked once. */
  mailSource: 'google' | 'email_connector' | null;
};

export type ReachSuggestion = { address: string; memory: string };

export type ReachTestChannel = 'in_app' | 'push' | 'text' | 'call';

/** How much a text says. Private names only the kind of thing; full carries a reminder’s own words. */
export type TextMode = 'private' | 'full';

/** The person's number for texts and where confirming it stands. */
export type TextStatus = {
  /** The number as entered, or null before one is. */
  phone: string | null;
  /** Nothing is sent to the number until the person has proved it with a code. */
  confirmed: boolean;
  mode: TextMode;
  /** The person replied STOP. They confirm the number again to use texts. */
  optedOut: boolean;
  codePending: boolean;
  /** A new number waiting for its code. Texts keep going to the confirmed number until then. */
  pendingPhone: string | null;
  /** What a Private text says, word for word, as the server writes it. */
  privatePreview: string;
  /** The names and words the person lets Aman text besides the common words. */
  words: string[];
};

/** The number for texts, served by the host. Each call rejects with a message fit to show. */
export type TextsApi = {
  status(): Promise<TextStatus>;
  /** Texts a one-time code to the number. */
  sendCode(phone: string): Promise<TextStatus>;
  confirm(code: string): Promise<TextStatus>;
  setMode(mode: TextMode): Promise<TextStatus>;
  /** Lets Full texts carry a name or word. Rejects with the reason when the word cannot be added. */
  addWord(word: string): Promise<TextStatus>;
  removeWord(word: string): Promise<TextStatus>;
  /** Forgets the number and switches texts off. */
  remove(): Promise<void>;
};

/** The person's Reach me settings, served by the host. Each call rejects with a message fit to show. */
export type ReachApi = {
  get(): Promise<ReachView>;
  /** Saves and resolves to what the server now holds. */
  save(settings: ReachSettings): Promise<ReachView>;
  suggestions(): Promise<ReachSuggestion[]>;
  /** Sends a test through one channel. Resolves to how many devices a push notice reached. */
  test(channel: ReachTestChannel): Promise<{ devicesReached: number }>;
  texts: TextsApi;
};

/** The feed, the push devices and Reach me settings, served by the host. */
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
  reach: ReachApi;
};

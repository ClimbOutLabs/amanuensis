/** Where a reminder stands: still to come, held, delivered, or its time came and it did not go through. */
export type ReminderState = 'upcoming' | 'paused' | 'reminded' | 'missed';

/** One reminder the person set, as the reminders view draws it. The server owns the wire shape. */
export type ReminderItem = {
  id: string;
  /** What the reminder is for, in the words it was set with. */
  what: string;
  /** The IANA time zone the reminder times are read in. */
  timezone: string;
  /** True when the reminder runs again on a repeating timing. */
  repeats: boolean;
  /** When it runs, in plain words. */
  timing: string;
  state: ReminderState;
  /** ISO 8601 UTC, or null when nothing is queued. */
  nextDueAt: string | null;
  /** ISO 8601 UTC, or null if it has never reached the person. */
  lastRemindedAt: string | null;
  /** ISO 8601 UTC, or null if no time of its has passed yet. */
  lastDueAt: string | null;
  /** ISO 8601 UTC. */
  setAt: string;
  /** The persona the reminder was set with. */
  personaName: string;
  /** The chat the reminder was set in, or null when it was set elsewhere or that chat is gone. */
  sessionId: string | null;
};

/** The reminders list, served by the host. Read-only: reminders are set and changed in chat. */
export type RemindersApi = {
  /** Every reminder the person set. */
  listReminders(): Promise<ReminderItem[]>;
};

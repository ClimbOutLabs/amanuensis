import {
  LATEST_REMINDER_AT_METADATA_KEY,
  LATEST_REMINDER_METADATA_KEY,
  REMINDERS_METADATA_KEY,
} from '@truefoundry/trueforge-core/core/schedules/toolContract';

/** What the Reminders chat last received: the words, and when they arrived (ISO 8601). */
export type RemindersMarker = {
  latestText: string;
  latestAt: string;
};

/**
 * Reads the Reminders chat from session metadata. Null for any other chat. A Reminders chat that
 * has not received anything yet has empty `latestText` and `latestAt`.
 */
export function readSessionReminders(metadata: Record<string, string> | null | undefined): RemindersMarker | null {
  if (metadata == null || Reflect.get(metadata, REMINDERS_METADATA_KEY) !== 'true') return null;
  const text: unknown = Reflect.get(metadata, LATEST_REMINDER_METADATA_KEY);
  const at: unknown = Reflect.get(metadata, LATEST_REMINDER_AT_METADATA_KEY);
  return {
    latestText: typeof text === 'string' ? text : '',
    latestAt: typeof at === 'string' ? at : '',
  };
}

/** The Reminders marker of a UI session, wherever the server kept it (own prop or metadata). */
export function sessionRemindersMarker(session: object): RemindersMarker | null {
  if ('reminders' in session) {
    const own: unknown = Reflect.get(session, 'reminders');
    if (typeof own === 'object' && own !== null) {
      const text: unknown = Reflect.get(own, 'latestText');
      const at: unknown = Reflect.get(own, 'latestAt');
      return { latestText: typeof text === 'string' ? text : '', latestAt: typeof at === 'string' ? at : '' };
    }
  }
  if (!('metadata' in session)) return null;
  const metadata = Reflect.get(session, 'metadata');
  if (typeof metadata !== 'object' || metadata === null) return null;
  const record: Record<string, string> = {};
  for (const key of Object.keys(metadata)) {
    const value = Reflect.get(metadata, key);
    if (typeof value === 'string') record[key] = value;
  }
  return readSessionReminders(record);
}

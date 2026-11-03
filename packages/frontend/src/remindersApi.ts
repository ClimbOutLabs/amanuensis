import type { ReminderChat, ReminderItem, RemindersApi, ReminderState } from '@truefoundry/trueforge-ui';

import { apiPath } from './publicPath';

// The server owns the wire shape (src/schemas/reminders.ts). Bodies are checked here, never asserted: a reminder
// this version does not recognise is dropped rather than drawn wrong.
const REMINDERS_URL = '/api/v1/user/reminders';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function parseState(value: unknown): ReminderState | null {
  return value === 'upcoming' || value === 'paused' || value === 'reminded' || value === 'missed' ? value : null;
}

function parseItem(value: unknown): ReminderItem | null {
  if (!isRecord(value)) {
    return null;
  }
  const {
    id,
    what,
    timezone,
    repeats,
    timing,
    next_due_at: nextDueAt,
    last_reminded_at: lastRemindedAt,
    last_due_at: lastDueAt,
    set_at: setAt,
    persona_name: personaName,
  } = value;
  const state = parseState(value.state);
  if (
    typeof id !== 'string' ||
    typeof what !== 'string' ||
    typeof timezone !== 'string' ||
    typeof repeats !== 'boolean' ||
    typeof timing !== 'string' ||
    state === null ||
    !isNullableString(nextDueAt) ||
    !isNullableString(lastRemindedAt) ||
    !isNullableString(lastDueAt) ||
    typeof setAt !== 'string' ||
    typeof personaName !== 'string'
  ) {
    return null;
  }
  return {
    id,
    what,
    timezone,
    repeats,
    timing,
    state,
    nextDueAt,
    lastRemindedAt,
    lastDueAt,
    setAt,
    personaName,
  };
}

function parseChat(value: unknown): ReminderChat | null {
  if (!isRecord(value)) {
    return null;
  }
  return typeof value.session_id === 'string' && typeof value.title === 'string'
    ? { sessionId: value.session_id, title: value.title }
    : null;
}

function errorMessage({ body, status }: { body: unknown; status: number }): string {
  if (isRecord(body) && isRecord(body.error) && typeof body.error.message === 'string' && body.error.message !== '') {
    return body.error.message;
  }
  return `That did not work (error ${String(status)}). Try again in a moment.`;
}

/** Backs `RemindersProvider`: every reminder the signed-in person set, read-only. */
export function createRemindersApi(fetcher: typeof fetch): RemindersApi {
  return {
    async listReminders() {
      const response = await fetcher(apiPath(REMINDERS_URL));
      const body: unknown = await response.json().catch((): null => null);
      if (!response.ok) {
        throw new Error(errorMessage({ body, status: response.status }));
      }
      const rows: unknown = isRecord(body) ? body.data : undefined;
      const reminders = Array.isArray(rows) ? rows.map(parseItem).filter(item => item !== null) : [];
      return { reminders, remindersChat: parseChat(isRecord(body) ? body.reminders_chat : undefined) };
    },
  };
}

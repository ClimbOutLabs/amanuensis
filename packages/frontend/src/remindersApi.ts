import type { ReminderItem, RemindersApi, ReminderState } from '@truefoundry/trueforge-ui';

import { apiPath } from './publicPath';

// The server owns the wire shape (src/schemas/reminders.ts). Bodies are checked here, never asserted: a reminder
// this version does not recognise is dropped rather than drawn wrong.
const REMINDERS_URL = '/api/v1/user/reminders';
// A reminder is stored as a schedule, so deleting one goes through the schedules API, which checks it is theirs.
const SCHEDULES_URL = '/api/v1/schedules';
/** Schedules the server reads per page; the most it accepts. */
const PAGE_LIMIT = 100;
/** A stop for a server that keeps handing back a page token: no person has this many pages of schedules. */
const MAX_PAGES = 50;

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
    session_id: sessionId,
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
    typeof personaName !== 'string' ||
    !isNullableString(sessionId)
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
    sessionId,
  };
}

function errorMessage({ body, status }: { body: unknown; status: number }): string {
  if (isRecord(body) && isRecord(body.error) && typeof body.error.message === 'string' && body.error.message !== '') {
    return body.error.message;
  }
  return `That did not work (error ${String(status)}). Try again in a moment.`;
}

/** Backs `ReminderListProvider`: every reminder the signed-in person set, gathered page by page, and deleting one. */
export function createRemindersApi(fetcher: typeof fetch): RemindersApi {
  return {
    async listReminders() {
      const reminders: ReminderItem[] = [];
      let pageToken: string | undefined;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const query = new URLSearchParams({ limit: String(PAGE_LIMIT) });
        if (pageToken !== undefined) {
          query.set('page_token', pageToken);
        }
        const response = await fetcher(apiPath(`${REMINDERS_URL}?${query.toString()}`));
        const body: unknown = await response.json().catch((): null => null);
        if (!response.ok) {
          throw new Error(errorMessage({ body, status: response.status }));
        }
        const rows: unknown = isRecord(body) ? body.data : undefined;
        if (Array.isArray(rows)) {
          reminders.push(...rows.map(parseItem).filter(item => item !== null));
        }
        const next: unknown = isRecord(body) ? body.next_page_token : undefined;
        if (typeof next !== 'string' || next === '') {
          break;
        }
        pageToken = next;
      }
      return reminders;
    },
    async deleteReminder(id) {
      const response = await fetcher(apiPath(`${SCHEDULES_URL}/${encodeURIComponent(id)}`), { method: 'DELETE' });
      if (!response.ok) {
        const body: unknown = await response.json().catch((): null => null);
        throw new Error(errorMessage({ body, status: response.status }));
      }
    },
  };
}

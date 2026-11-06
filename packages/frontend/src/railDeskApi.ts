import type { TrueForge } from '@truefoundry/trueforge-sdk';
import type {
  RailAttachment,
  RailDeskApi,
  RailToday,
  RailTodayDueReminder,
  RailTodayEvent,
  RailTodayNeedsOkItem,
} from '@truefoundry/trueforge-ui';
import { listDocumentIngestionTurnContext } from '@truefoundry/trueforge-ui/plugins/trueforge-agent-server-adapter';

/**
 * The right rail's desk, backed by the server's stored state: `GET /api/v1/today` for Home,
 * the session's own ingestion records for its attachments, and the recall-exclusion write for
 * pulling a fact out of one chat. None of these reads goes near a model.
 */

const TODAY_URL = '/api/v1/today';
/** Most attachments the desk lists for one chat. */
const ATTACHMENT_CAP = 8;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringOrNull(value: unknown): value is string | null {
  return typeof value === 'string' || value === null;
}

function errorMessage({ body, status }: { body: unknown; status: number }): string {
  if (isRecord(body) && isRecord(body.error) && typeof body.error.message === 'string') {
    return body.error.message;
  }
  return `Request failed (${String(status)}).`;
}

function readEvent(value: unknown): RailTodayEvent | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const { day, start_at, end_at, title, location, all_day, source, calendar_account_id } = value;
  if (
    (day !== 'today' && day !== 'tomorrow') ||
    typeof start_at !== 'string' ||
    !isStringOrNull(end_at) ||
    typeof title !== 'string' ||
    !isStringOrNull(location) ||
    typeof all_day !== 'boolean' ||
    (source !== 'google' && source !== 'caldav') ||
    typeof calendar_account_id !== 'string'
  ) {
    return undefined;
  }
  return { day, start_at, end_at, title, location, all_day, source, calendar_account_id };
}

function readDueReminder(value: unknown): RailTodayDueReminder | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const { reminder_id, title, due_at, session_id } = value;
  if (
    typeof reminder_id !== 'string' ||
    typeof title !== 'string' ||
    typeof due_at !== 'string' ||
    !isStringOrNull(session_id)
  ) {
    return undefined;
  }
  return { reminder_id, title, due_at, session_id };
}

function readNeedsOkItem(value: unknown): RailTodayNeedsOkItem | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const { held_action_id, title, origin, session_id } = value;
  if (
    typeof held_action_id !== 'string' ||
    typeof title !== 'string' ||
    typeof origin !== 'string' ||
    typeof session_id !== 'string'
  ) {
    return undefined;
  }
  return { held_action_id, title, origin, session_id };
}

function readToday(value: unknown): RailToday | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const { calendar, free_after, due, needs_ok, needs_ok_more, carrying, as_of } = value;
  if (
    !isStringOrNull(free_after) ||
    typeof needs_ok_more !== 'boolean' ||
    typeof carrying !== 'number' ||
    typeof as_of !== 'string'
  ) {
    return undefined;
  }
  if (calendar !== null && !Array.isArray(calendar)) {
    return undefined;
  }
  if (!Array.isArray(due) || !Array.isArray(needs_ok)) {
    return undefined;
  }
  const events = calendar === null ? null : calendar.map(readEvent);
  const reminders = due.map(readDueReminder);
  const held = needs_ok.map(readNeedsOkItem);
  if (
    events?.some(event => event === undefined) === true ||
    reminders.some(reminder => reminder === undefined) ||
    held.some(item => item === undefined)
  ) {
    return undefined;
  }
  return {
    calendar: events === null ? null : events.filter(event => event !== undefined),
    free_after,
    due: reminders.filter(reminder => reminder !== undefined),
    needs_ok: held.filter(item => item !== undefined),
    needs_ok_more,
    carrying,
    as_of,
  };
}

/** Plain words for where an attached file's reading stands. */
function phaseDetail(phase: string): string {
  switch (phase) {
    case 'started':
      return 'Being read';
    case 'finished':
      return 'Read';
    case 'failed':
      return 'Could not be read';
    case 'cancelled':
      return 'Reading stopped';
    default:
      return phase;
  }
}

export function createRailDeskApi({ fetcher, client }: { fetcher: typeof fetch; client: TrueForge }): RailDeskApi {
  return {
    async getToday({ timeZone }) {
      const query = timeZone === undefined ? '' : `?client_timezone=${encodeURIComponent(timeZone)}`;
      const response = await fetcher(`${TODAY_URL}${query}`);
      const body: unknown = await response.json().catch((): null => null);
      if (!response.ok) {
        throw new Error(errorMessage({ body, status: response.status }));
      }
      const today = readToday(isRecord(body) ? body.data : undefined);
      if (today === undefined) {
        throw new Error('The today response was invalid.');
      }
      return today;
    },
    async excludeRecallFact({ sessionId, factText }) {
      const response = await fetcher(`/api/v1/sessions/${encodeURIComponent(sessionId)}/recall-exclusions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fact_text: factText }),
      });
      if (!response.ok) {
        const body: unknown = await response.json().catch((): null => null);
        throw new Error(errorMessage({ body, status: response.status }));
      }
    },
    async listAttachments({ sessionId }): Promise<RailAttachment[]> {
      const turns = await listDocumentIngestionTurnContext(client, { sessionId });
      const seen = new Set<string>();
      const attachments: RailAttachment[] = [];
      for (const turn of [...turns].reverse()) {
        for (const file of [...turn.files].reverse()) {
          if (seen.has(file.fileName)) {
            continue;
          }
          seen.add(file.fileName);
          attachments.push({ id: file.fileName, label: file.fileName, detail: phaseDetail(file.phase) });
          if (attachments.length >= ATTACHMENT_CAP) {
            return attachments;
          }
        }
      }
      return attachments;
    },
  };
}

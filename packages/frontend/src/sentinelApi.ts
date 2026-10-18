import {
  extractSentinelSessionContext,
  parseAuditEntries,
  parseUserAuditPage,
  parseUserSettings,
  type SentinelApi,
  type SentinelSessionContext,
  type SentinelUserSettings,
} from '@truefoundry/trueforge-ui';

// Sentinel HTTP routes. Tier, card, Tier 2 kind, audit-outcome, and settings shapes are
// owned by the server (trueforge-core permissions and the server settings schema). All
// response bodies are parsed defensively: unknown shapes are dropped, never asserted.
const AUDIT_LOG_URL = (sessionId: string) => `/api/v1/sessions/${encodeURIComponent(sessionId)}/audit-log`;
const SETTINGS_URL = '/api/v1/user/settings/sentinel';
const USER_AUDIT_LOG_URL = '/api/v1/user/audit-log';

async function readError(response: Response): Promise<Error> {
  const body: unknown = await response.json().catch(() => null);
  const message = errorMessageFrom(body) ?? `Request failed (${String(response.status)}).`;
  console.error('Sentinel request failed', { status: response.status, body });
  return new Error(message);
}

// `response.json()` is untrusted runtime data, so every shape below is checked, not
// asserted: an unrecognized body falls through to the status-based message.
function errorMessageFrom(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) {
    return undefined;
  }
  const fields = Object.entries(body);
  const field = (name: string): unknown => fields.find(([key]) => key === name)?.[1];
  const error: unknown = field('error');
  if (typeof error === 'string' && error !== '') {
    return error;
  }
  if (typeof error === 'object' && error !== null) {
    const nested: unknown = Object.entries(error).find(([key]) => key === 'message')?.[1];
    if (typeof nested === 'string' && nested !== '') {
      return nested;
    }
  }
  const topMessage = field('message');
  return typeof topMessage === 'string' && topMessage !== '' ? topMessage : undefined;
}

/** Largest page the server serves for session events; a bigger `limit` is refused with a 400. */
export const SESSION_EVENTS_PAGE_SIZE = 100;

interface SessionEventsPage {
  data: { event: unknown }[];
  nextPageToken: string | undefined;
}

/**
 * Reads every persisted event of a session, a page at a time. The page size stays within what the
 * server accepts: a refused page would leave a reloaded tab with no approval cards at all.
 */
export async function readAllSessionEvents(
  listPage: (input: { limit: number; pageToken?: string }) => Promise<SessionEventsPage>,
): Promise<unknown[]> {
  const events: unknown[] = [];
  let pageToken: string | undefined;
  do {
    const page = await listPage({
      limit: SESSION_EVENTS_PAGE_SIZE,
      ...(pageToken === undefined ? {} : { pageToken }),
    });
    for (const item of page.data) {
      events.push(item.event);
    }
    pageToken = page.nextPageToken;
  } while (pageToken !== undefined);
  return events;
}

export interface SentinelApiDeps {
  fetcher: typeof fetch;
  /** Raw persisted session events (the SDK `event` payloads), oldest or newest first. */
  listSessionEvents: (sessionId: string) => Promise<unknown[]>;
}

export function createSentinelApi({ fetcher, listSessionEvents }: SentinelApiDeps): SentinelApi {
  return {
    async listAuditEntries({ sessionId, limit = 50 }) {
      const response = await fetcher(`${AUDIT_LOG_URL(sessionId)}?limit=${String(limit)}`);
      if (!response.ok) {
        throw await readError(response);
      }
      return parseAuditEntries(await response.json());
    },

    async listUserAuditEntries({ limit = 50, pageToken, outcome }) {
      const query = new URLSearchParams({ limit: String(limit) });
      if (pageToken !== undefined) {
        query.set('page_token', pageToken);
      }
      if (outcome !== undefined) {
        query.set('outcome', outcome);
      }
      const response = await fetcher(`${USER_AUDIT_LOG_URL}?${query.toString()}`);
      if (!response.ok) {
        throw await readError(response);
      }
      return parseUserAuditPage(await response.json());
    },

    async getUserSettings() {
      const response = await fetcher(SETTINGS_URL);
      if (!response.ok) {
        throw await readError(response);
      }
      return parseUserSettings(await response.json());
    },

    async updateUserSettings(patch: Partial<SentinelUserSettings>) {
      const response = await fetcher(SETTINGS_URL, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!response.ok) {
        throw await readError(response);
      }
      return parseUserSettings(await response.json());
    },

    async listSentinelSessionContext(sessionId: string): Promise<SentinelSessionContext> {
      return extractSentinelSessionContext(await listSessionEvents(sessionId));
    },
  };
}

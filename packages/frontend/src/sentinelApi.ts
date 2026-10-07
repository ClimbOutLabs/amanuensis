import {
  extractSentinelSessionContext,
  parseAuditEntries,
  parseUserSettings,
  type SentinelApi,
  type SentinelSessionContext,
  type SentinelUserSettings,
} from '@truefoundry/trueforge-ui';

// Sentinel HTTP routes. Tier, card, Tier 2 kind, and audit-outcome shapes are confirmed
// against the backend contracts in trueforge-core; the routes themselves are still
// being finalized server-side, so confirm before release. All response bodies are
// parsed defensively: unknown shapes are dropped, never asserted.
const AUDIT_LOG_URL = (sessionId: string) =>
  `/api/v1/sessions/${encodeURIComponent(sessionId)}/audit-log`;
const SETTINGS_URL = '/api/v1/user/settings/sentinel';
const NOTICE_ACTION_URL = (sessionId: string, noticeId: string, action: 'undo' | 'stop') =>
  `/api/v1/sessions/${encodeURIComponent(sessionId)}/sentinel/notices/${encodeURIComponent(noticeId)}/${action}`;

async function readError(response: Response): Promise<Error> {
  const body: unknown = await response.json().catch(() => null);
  const message = errorMessageFrom(body) ?? `Request failed (${String(response.status)}).`;
  console.error('Sentinel request failed', { status: response.status, body });
  return new Error(message);
}

// `response.json()` is untrusted runtime data, so every shape below is checked, not
// asserted: an unrecognized body falls through to the status-based message.
function errorMessageFrom(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const fields = Object.entries(body);
  const field = (name: string): unknown => fields.find(([key]) => key === name)?.[1];
  const error = field('error');
  if (typeof error === 'string' && error !== '') return error;
  if (typeof error === 'object' && error !== null) {
    const nested = Object.entries(error).find(([key]) => key === 'message')?.[1];
    if (typeof nested === 'string' && nested !== '') return nested;
  }
  const topMessage = field('message');
  return typeof topMessage === 'string' && topMessage !== '' ? topMessage : undefined;
}

export type SentinelApiDeps = {
  fetcher: typeof fetch;
  /** Raw persisted session events (the SDK `event` payloads), oldest or newest first. */
  listSessionEvents: (sessionId: string) => Promise<unknown[]>;
};

export function createSentinelApi({ fetcher, listSessionEvents }: SentinelApiDeps): SentinelApi {
  return {
    async listAuditEntries({ sessionId, limit = 50 }) {
      const response = await fetcher(`${AUDIT_LOG_URL(sessionId)}?limit=${String(limit)}`);
      if (!response.ok) throw await readError(response);
      return parseAuditEntries(await response.json());
    },

    async getUserSettings() {
      const response = await fetcher(SETTINGS_URL);
      // A server predating Sentinel has no settings route: fall back to safe defaults.
      if (response.status === 404) return { offline_mode: false, tier2_always_ask: [] };
      if (!response.ok) throw await readError(response);
      return parseUserSettings(await response.json());
    },

    async updateUserSettings(patch: Partial<SentinelUserSettings>) {
      const response = await fetcher(SETTINGS_URL, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!response.ok) throw await readError(response);
      return parseUserSettings(await response.json());
    },

    async undoTier2Action({ sessionId, noticeId }) {
      const response = await fetcher(NOTICE_ACTION_URL(sessionId, noticeId, 'undo'), {
        method: 'POST',
      });
      if (!response.ok) throw await readError(response);
    },

    async stopTier2Action({ sessionId, noticeId }) {
      const response = await fetcher(NOTICE_ACTION_URL(sessionId, noticeId, 'stop'), {
        method: 'POST',
      });
      if (!response.ok) throw await readError(response);
    },

    async listSentinelSessionContext(sessionId: string): Promise<SentinelSessionContext> {
      return extractSentinelSessionContext(await listSessionEvents(sessionId));
    },
  };
}

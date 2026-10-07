/**
 * Sentinel three-tier permissions: wire types and defensive parsers.
 *
 * Tier, card, Tier 2 kind, and audit-outcome shapes mirror the backend contracts in
 * trueforge-core (`permissions/tier.ts`, `permissions/audit.ts`); the server is the
 * canonical owner and the UI never re-derives these values. Sentinel data arrives per
 * tool-call reference on `tool.approval_required` / `tool.tier2_notice` events, with a
 * fallback read of the event top level for single-action events; audit history and
 * user settings come over HTTP. Every parser checks shapes instead of asserting them:
 * both event placements are accepted and anything unrecognized is dropped.
 *
 * The event envelope and the HTTP routes are still being finalized server-side, so
 * parsers also accept the provisional field names alongside the backend ones.
 *
 * UI rule for consumers: never infer a tier. Tier-specific UI renders only when the
 * server sent an explicit `tier`.
 */

/** Sentinel permission tier: 1 silent, 2 inline notice, 3 approval card. */
export const TOOL_TIERS = [1, 2, 3] as const;

export type ToolTier = (typeof TOOL_TIERS)[number];

export function parseToolTier(value: unknown): ToolTier | undefined {
  return value === 1 || value === 2 || value === 3 ? value : undefined;
}

/** Tier 2 action kinds with a per-user "always ask me" toggle. Pinned to the backend list. */
export const TIER2_ACTION_KINDS = ['file_write', 'shell', 'runner', 'branch'] as const;

export type Tier2ActionKind = (typeof TIER2_ACTION_KINDS)[number];

/** Human-readable labels for Tier 2 action kinds. */
export const TIER2_ACTION_LABELS: Record<Tier2ActionKind, string> = {
  file_write: 'Write files',
  shell: 'Run shell commands',
  runner: 'Run code',
  branch: 'Manage git branches',
};

export function parseTier2ActionKind(value: unknown): Tier2ActionKind | undefined {
  for (const kind of TIER2_ACTION_KINDS) {
    if (value === kind) return kind;
  }
  return undefined;
}

/**
 * Server-rendered Tier 3 approval card. Mirrors the backend `Tier3Card` schema:
 * destination/recipient/amount come from the server-side extractor registry over
 * canonical params, never agent text. Shell cards carry the server-parsed command.
 */
export type SentinelApprovalCard = {
  /** One plain-language sentence describing what will happen. No jargon. Always present. */
  plain_what: string;
  /** One sentence on why the agent wants this, from agent intent when available. */
  plain_why: string | null;
  /** What cannot be undone, or null when fully reversible. */
  cannot_be_undone: string | null;
  /** Actual cause of re-escalation, or null on first ask. */
  why_asked_again: string | null;
  /** Verifiable destination (URL, service name), or null. */
  destination: string | null;
  /** Verifiable recipient (address, handle), or null. */
  recipient: string | null;
  /** Verifiable amount, or null. */
  amount: string | null;
  /** Server-parsed command structure for shell actions, or null. */
  parsed_command: string | null;
};

/** Everything the UI needs to render a Tier 3 approval, keyed to one tool call. */
export type SentinelApprovalInfo = {
  toolCallId: string;
  tier: ToolTier;
  card: SentinelApprovalCard;
};

/** Non-blocking notice for an action that ran under Tier 2. */
export type Tier2Notice = {
  toolCallId: string;
  /** Plain-language description of what ran. */
  message: string;
  /** Tier 2 member kind, for the per-action "always ask me" toggle lookup. */
  kind: Tier2ActionKind | null;
  undoable: boolean;
  stoppable: boolean;
  /** Tracked executable files the server named in the inline indicator. */
  tracked_files: string[];
  /** Identifier for the undo/stop endpoints; falls back to the tool call id. */
  notice_id: string;
};

export const SENTINEL_AUDIT_OUTCOMES = [
  'logged',
  'ran',
  'stopped_by_user',
  'undone',
  'approved',
  'denied',
  'auto_denied',
] as const;

export type SentinelAuditOutcome = (typeof SENTINEL_AUDIT_OUTCOMES)[number];

function parseAuditOutcome(value: unknown): SentinelAuditOutcome | undefined {
  for (const outcome of SENTINEL_AUDIT_OUTCOMES) {
    if (value === outcome) return outcome;
  }
  return undefined;
}

/** One row of the permissions audit feed. */
export type SentinelAuditEntry = {
  id: string;
  session_id: string;
  /** ISO timestamp; rendered in the user's locale. */
  created_at: string;
  tier: ToolTier;
  /** Tool that ran, e.g. `exec`. */
  action_type: string;
  /** Plain-language description of what happened. */
  description: string;
  outcome: SentinelAuditOutcome;
  /** Auto-denial reason, when the server sent one. */
  reason?: string;
};

/** User-level Sentinel preferences. */
export type SentinelUserSettings = {
  /** While on, external Tier 3 actions are auto-denied without an approval card. */
  offline_mode: boolean;
  /** Tier 2 action kinds the user escalated to always ask. Default: all kinds. */
  tier2_always_ask: Tier2ActionKind[];
};

/**
 * Host-provided Sentinel backend access. The frontend implements this against the
 * server's HTTP API plus the SDK client; trueforge-ui only declares the contract.
 *
 * The HTTP routes are still being finalized server-side (provisional):
 * - `GET /api/v1/sessions/{sessionId}/audit-log?limit=N` -> `{ entries: [...] }`
 * - `GET /api/v1/user/settings/sentinel` -> settings object
 * - `PATCH /api/v1/user/settings/sentinel` with a settings patch -> updated settings
 * - `POST /api/v1/sessions/{sessionId}/sentinel/notices/{noticeId}/undo`
 * - `POST /api/v1/sessions/{sessionId}/sentinel/notices/{noticeId}/stop`
 */
export type SentinelApi = {
  listAuditEntries: (input: { sessionId: string; limit?: number }) => Promise<SentinelAuditEntry[]>;
  getUserSettings: () => Promise<SentinelUserSettings>;
  updateUserSettings: (patch: Partial<SentinelUserSettings>) => Promise<SentinelUserSettings>;
  undoTier2Action: (input: { sessionId: string; noticeId: string }) => Promise<void>;
  stopTier2Action: (input: { sessionId: string; noticeId: string }) => Promise<void>;
  /**
   * Durable read of Sentinel state for a session: approval cards and Tier 2 notices
   * rebuilt from persisted `tool.approval_required` / `tool.tier2_notice` events, so a
   * reloaded tab shows the same cards and notices the live stream already delivered.
   */
  listSentinelSessionContext: (sessionId: string) => Promise<SentinelSessionContext>;
};

/** Durable per-tool-call Sentinel state for one session. */
export type SentinelSessionContext = {
  approvals: SentinelApprovalInfo[];
  notices: Tier2Notice[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function nullableString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

function optionalBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === 'boolean' ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function tier2ActionKindArray(value: unknown): Tier2ActionKind[] {
  if (!Array.isArray(value)) return [];
  const kinds: Tier2ActionKind[] = [];
  for (const item of value) {
    const kind = parseTier2ActionKind(item);
    if (kind !== undefined && !kinds.includes(kind)) kinds.push(kind);
  }
  return kinds;
}

function parseApprovalCard(value: unknown): SentinelApprovalCard | undefined {
  if (!isRecord(value)) return undefined;
  const plain_what = optionalString(value, 'plain_what');
  if (plain_what === undefined) return undefined;
  return {
    plain_what,
    plain_why: nullableString(value, 'plain_why'),
    cannot_be_undone: nullableString(value, 'cannot_be_undone'),
    why_asked_again: nullableString(value, 'why_asked_again'),
    destination: nullableString(value, 'destination'),
    recipient: nullableString(value, 'recipient'),
    amount: nullableString(value, 'amount'),
    parsed_command: nullableString(value, 'parsed_command'),
  };
}

function toolCallIdFrom(record: Record<string, unknown>): string | undefined {
  return (
    optionalString(record, 'tool_call_id') ??
    optionalString(record, 'id') ??
    optionalString(record, 'approval_id')
  );
}

function parseApprovalInfo(ref: Record<string, unknown>): SentinelApprovalInfo | undefined {
  const tier = parseToolTier(ref.tier);
  // The backend stamps the decision card as `tier3_card`; `card` is the provisional name.
  const card = parseApprovalCard(ref.tier3_card ?? ref.card);
  const toolCallId = toolCallIdFrom(ref);
  if (tier === undefined || card === undefined || toolCallId === undefined) return undefined;
  return { toolCallId, tier, card };
}

function parseTier2Notice(ref: Record<string, unknown>): Tier2Notice | undefined {
  const tier = parseToolTier(ref.tier);
  if (tier !== 2) return undefined;
  const toolCallId = toolCallIdFrom(ref);
  const message = optionalString(ref, 'message') ?? optionalString(ref, 'plain_message');
  if (toolCallId === undefined || message === undefined) return undefined;
  return {
    toolCallId,
    message,
    kind: parseTier2ActionKind(ref.tier2_kind) ?? null,
    undoable: optionalBoolean(ref, 'undoable') ?? false,
    stoppable: optionalBoolean(ref, 'stoppable') ?? false,
    // The backend names these `tier2_files`; `tracked_files` is the provisional name.
    tracked_files: stringArray(ref.tier2_files ?? ref.tracked_files),
    notice_id: optionalString(ref, 'notice_id') ?? toolCallId,
  };
}

const SENTINEL_EVENT_TYPES = ['tool.approval_required', 'tool.tier2_notice'] as const;

function isSentinelEventType(value: unknown): value is (typeof SENTINEL_EVENT_TYPES)[number] {
  if (typeof value !== 'string') return false;
  for (const eventType of SENTINEL_EVENT_TYPES) {
    if (value === eventType) return true;
  }
  return false;
}

function toolCallRefs(event: Record<string, unknown>): Record<string, unknown>[] {
  const refs = event.tool_calls;
  if (Array.isArray(refs)) return refs.filter(isRecord);
  // Single-action events may carry the per-action fields at the top level.
  return [event];
}

/**
 * Extracts Sentinel approval info and Tier 2 notices from one raw session event.
 * Accepts the parsed JSON of either an SSE streaming event or a persisted session
 * event; returns nothing for events that carry no Sentinel data.
 */
export function extractSentinelFromEvent(event: unknown): {
  approvals: SentinelApprovalInfo[];
  notices: Tier2Notice[];
} {
  const empty = { approvals: [], notices: [] };
  if (!isRecord(event)) return empty;
  if (!isSentinelEventType(event.type)) return empty;
  const approvals: SentinelApprovalInfo[] = [];
  const notices: Tier2Notice[] = [];
  for (const ref of toolCallRefs(event)) {
    const approval = parseApprovalInfo(ref);
    if (approval !== undefined) approvals.push(approval);
    const notice = parseTier2Notice(ref);
    if (notice !== undefined) notices.push(notice);
  }
  return { approvals, notices };
}

/** Folds raw session events into per-tool-call Sentinel state (later events win). */
export function extractSentinelSessionContext(events: unknown[]): SentinelSessionContext {
  const approvals = new Map<string, SentinelApprovalInfo>();
  const notices = new Map<string, Tier2Notice>();
  for (const event of events) {
    const { approvals: foundApprovals, notices: foundNotices } = extractSentinelFromEvent(event);
    for (const approval of foundApprovals) approvals.set(approval.toolCallId, approval);
    for (const notice of foundNotices) notices.set(notice.toolCallId, notice);
  }
  return { approvals: [...approvals.values()], notices: [...notices.values()] };
}

function parseAuditEntry(value: unknown): SentinelAuditEntry | undefined {
  if (!isRecord(value)) return undefined;
  const id = optionalString(value, 'id') ?? optionalString(value, 'entry_id');
  // The backend audit record carries `conversation_id`; `session_id` is the provisional name.
  const session_id = optionalString(value, 'conversation_id') ?? optionalString(value, 'session_id');
  const created_at = optionalString(value, 'created_at');
  const tier = parseToolTier(value.tier);
  // The backend records the tool name; `action_type` is the provisional name.
  const action_type = optionalString(value, 'tool_name') ?? optionalString(value, 'action_type');
  const description = optionalString(value, 'description');
  const outcome = parseAuditOutcome(value.outcome);
  if (
    id === undefined ||
    session_id === undefined ||
    created_at === undefined ||
    tier === undefined ||
    action_type === undefined ||
    description === undefined ||
    outcome === undefined
  ) {
    return undefined;
  }
  const entry: SentinelAuditEntry = {
    id,
    session_id,
    created_at,
    tier,
    action_type,
    description,
    outcome,
  };
  // The backend names this `auto_deny_reason`; `reason` is the provisional name.
  const reason = optionalString(value, 'auto_deny_reason') ?? optionalString(value, 'reason');
  if (reason !== undefined) entry.reason = reason;
  return entry;
}

/** Parses an audit-log response body: `{ entries: [...] }` or a bare array. */
export function parseAuditEntries(body: unknown): SentinelAuditEntry[] {
  const list = isRecord(body) ? body.entries : body;
  if (!Array.isArray(list)) return [];
  const entries: SentinelAuditEntry[] = [];
  for (const item of list) {
    const entry = parseAuditEntry(item);
    if (entry !== undefined) entries.push(entry);
  }
  return entries;
}

/** Parses user settings; absent fields fall back to safe defaults (all off). */
export function parseUserSettings(body: unknown): SentinelUserSettings {
  if (!isRecord(body)) return { offline_mode: false, tier2_always_ask: [] };
  return {
    offline_mode: optionalBoolean(body, 'offline_mode') ?? false,
    tier2_always_ask: tier2ActionKindArray(body.tier2_always_ask),
  };
}

/**
 * Sentinel three-tier permissions: wire types and defensive parsers.
 *
 * Tier, card, Tier 2 kind, and audit-outcome shapes mirror the backend contracts in
 * trueforge-core (`permissions/tier.ts`, `permissions/audit.ts`) and the settings
 * schema in the server package; the server is the canonical owner and the UI never
 * re-derives these values. Approval cards arrive per tool-call reference on
 * `tool.approval_required` events, with a fallback read of the event top level for
 * single-action events; audit history and user settings come over HTTP. Every parser
 * checks shapes instead of asserting them: both event placements are accepted and
 * anything unrecognized is dropped.
 *
 * UI rule for consumers: never infer a tier. Tier-specific UI renders only when the
 * server sent an explicit `tier`.
 */
import {
  heldBecause,
  savedSearchHoldReason,
  SERVER_SECRET_REASON,
} from '@truefoundry/trueforge-core/core/permissions/searchHoldText';
import { readStoredMailbox, type Tier3Mailbox } from '@truefoundry/trueforge-core/core/permissions/tierMailbox';

/** Sentinel permission tier: 1 silent, 2 asks unless the user relaxed its kind, 3 always asks. */
export const TOOL_TIERS = [1, 2, 3] as const;

export type ToolTier = (typeof TOOL_TIERS)[number];

export function parseToolTier(value: unknown): ToolTier | undefined {
  return value === 1 || value === 2 || value === 3 ? value : undefined;
}

/** Tier 2 action kinds the user may relax to run without asking. Pinned to the backend list. */
export const TIER2_ACTION_KINDS = ['file_write'] as const;

export type Tier2ActionKind = (typeof TIER2_ACTION_KINDS)[number];

/** Human-readable labels for Tier 2 action kinds. */
export const TIER2_ACTION_LABELS: Record<Tier2ActionKind, string> = {
  file_write: 'Write files',
};

export function parseTier2ActionKind(value: unknown): Tier2ActionKind | undefined {
  for (const kind of TIER2_ACTION_KINDS) {
    if (value === kind) return kind;
  }
  return undefined;
}

const APPROVAL_EMAIL_ACTIONS = ['send', 'save', 'change'] as const;

export type SentinelApprovalEmailAction = (typeof APPROVAL_EMAIL_ACTIONS)[number];

/** One recipient of a mail card: the name it is shown with, empty when it has none, and the address mail goes to. */
export type SentinelApprovalMailbox = Tier3Mailbox;

/** The whole message of a mail card, so what is approved is everything that is sent. */
export type SentinelApprovalEmail = {
  action: SentinelApprovalEmailAction;
  to: SentinelApprovalMailbox[];
  cc: SentinelApprovalMailbox[];
  bcc: SentinelApprovalMailbox[];
  subject: string;
  body: string;
  /** The saved draft a change replaces, or null. */
  replaces: { subject: string; to: SentinelApprovalMailbox[] } | null;
  /** The message a reply answers in its thread, or null when the message is not a reply. */
  reply_in_thread: { subject: string; from: string } | null;
};

const APPROVAL_CALENDAR_ACTIONS = ['create', 'change'] as const;

export type SentinelApprovalCalendarAction = (typeof APPROVAL_CALENDAR_ACTIONS)[number];

/** The whole event of a calendar card, in plain words, so what is approved is everything that is written. */
export type SentinelApprovalCalendarEvent = {
  action: SentinelApprovalCalendarAction;
  /** The account whose main calendar is written. */
  calendar: string;
  title: string;
  /** Local date and time in plain words. */
  when: string;
  time_zone: string;
  duration: string;
  /** Empty when there is none. */
  location: string;
  /** Empty when the write sets none. */
  description: string;
  attendees: string[];
  /** True when Google emails the guests about this. */
  guests_emailed: boolean;
  /** True when a change touches one date of a repeating event. */
  one_of_repeating: boolean;
  /** The event as it is now, for a change; null for a new event. */
  before: { title: string; when: string; duration: string; location: string } | null;
};

const APPROVAL_SCHEDULE_ACTIONS = ['create', 'delete'] as const;

export type SentinelApprovalScheduleAction = (typeof APPROVAL_SCHEDULE_ACTIONS)[number];

/** The whole schedule a chat call creates or deletes, in plain words. */
export type SentinelApprovalSchedule = {
  action: SentinelApprovalScheduleAction;
  /** Schedule name in plain words. */
  name: string;
  /** When it runs, in plain words. */
  when: string;
  time_zone: string;
  /** The whole instruction each run gets. */
  task: string;
  /** Who runs it: the assistant name, or the agent name. */
  runs_as: string;
  /** The next three runs in plain words for a new schedule; empty for a delete. */
  next_runs: string[];
};

/**
 * Server-rendered approval card for Tier 2 and Tier 3 actions. Mirrors the backend `Tier3Card` schema:
 * destination/recipient/amount come from the server-side extractor registry over
 * canonical params, never agent text. Shell cards carry the server-parsed command.
 * Connector cards carry the exact arguments sent and the connector server's host.
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
  /** Exact arguments sent to a connector, one "name: value" line each, or null. */
  outbound_text: string | null;
  /** Host of the connector server that receives the call, or null. */
  destination_host: string | null;
  /** True when part of outbound_text is cut and not shown in full. */
  outbound_truncated: boolean;
  /** The whole message when the action is sending or saving mail, or null. */
  email: SentinelApprovalEmail | null;
  /** The whole event when the action adds or changes a calendar event, or null. */
  calendar_event: SentinelApprovalCalendarEvent | null;
  /** The whole schedule when the action creates or deletes one, or null. */
  schedule: SentinelApprovalSchedule | null;
};

/** What the server says about an action a scheduled run held for its owner instead of asking. */
export type HeldActionInfo = {
  /** Whether "Always allow" may be offered; the server refuses it for other tools. */
  alwaysAllowOffered: boolean;
  /** ISO time after which the held action can no longer be approved, or null when not sent. */
  expiresAt: string | null;
};

/** Everything the UI needs to render a Tier 2 or Tier 3 approval, keyed to one tool call. */
export type SentinelApprovalInfo = {
  toolCallId: string;
  tier: ToolTier;
  card: SentinelApprovalCard;
  /** Id of the `tool.approval_required` event that asked; calls from one event share it. */
  eventId: string | null;
  /** Thread that owns the call; a sub-agent's calls carry its own thread id. */
  threadId: string | null;
  /** False when the server refuses chat scope for this call; absent from servers that do not say. */
  chatAllowOffered?: boolean | undefined;
  /** Present only for an action a scheduled run held; such a card never pauses the chat. */
  held?: HeldActionInfo | undefined;
  /** Present only for an action a scheduled run could not save for the owner, and why. */
  notSaved?: NotSavedReason | undefined;
};

/** Why a scheduled run could not save an action that needed the owner's OK. */
export type NotSavedReason = 'too_many' | 'helper_agent';

/** A recorded answer to an approval request. */
export type ApprovalAnswer = 'approved' | 'denied';

export const SENTINEL_AUDIT_OUTCOMES = ['logged', 'ran', 'approved', 'denied', 'auto_denied'] as const;

export type SentinelAuditOutcome = (typeof SENTINEL_AUDIT_OUTCOMES)[number];

/** Plain-word outcome labels for the owner. `logged` covers held actions and noted sensitive reads. */
export const SENTINEL_AUDIT_OUTCOME_LABELS: Record<SentinelAuditOutcome, string> = {
  logged: 'Held or noted',
  ran: 'Ran',
  approved: 'Approved',
  denied: 'Denied',
  auto_denied: 'Refused',
};

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

/** One row of the owner's audit log across every chat. */
export type SentinelUserAuditEntry = SentinelAuditEntry & {
  /** False once the chat the entry came from has been deleted. */
  chat_exists: boolean;
};

/** One page of the owner's audit log; `nextPageToken` is absent on the last page. */
export type SentinelUserAuditPage = {
  entries: SentinelUserAuditEntry[];
  nextPageToken?: string | undefined;
};

/** User-level Sentinel preferences. */
export type SentinelUserSettings = {
  /** While on, actions that reach outside this machine are auto-denied without an approval card. */
  offline_mode: boolean;
  /** Tier 2 action kinds that run without asking. Default: none, so Tier 2 asks. */
  tier2_auto_allow: Tier2ActionKind[];
  /** While on, the search provider you designated runs web searches without asking. Default: on. */
  search_without_asking: boolean;
  /** While on, maps run without asking; after a mail or calendar read they are checked first. Default: off. */
  maps_without_asking: boolean;
};

/**
 * Host-provided Sentinel backend access. The frontend implements this against the
 * server's HTTP API plus the SDK client; trueforge-ui only declares the contract.
 *
 * - `GET /api/v1/sessions/{sessionId}/audit-log?limit=N` -> `{ entries: [...] }`
 * - `GET /api/v1/user/audit-log?limit=N&page_token=T&outcome=O` -> `{ data: [...], pagination }`
 * - `GET /api/v1/user/settings/sentinel` -> `{ data: settings }`
 * - `PATCH /api/v1/user/settings/sentinel` with a settings patch -> `{ data: settings }`
 */
export type SentinelApi = {
  listAuditEntries: (input: { sessionId: string; limit?: number }) => Promise<SentinelAuditEntry[]>;
  listUserAuditEntries: (input: {
    limit?: number;
    pageToken?: string | undefined;
    outcome?: SentinelAuditOutcome | undefined;
  }) => Promise<SentinelUserAuditPage>;
  getUserSettings: () => Promise<SentinelUserSettings>;
  updateUserSettings: (patch: Partial<SentinelUserSettings>) => Promise<SentinelUserSettings>;
  /**
   * Durable read of Sentinel state for a session: approval cards rebuilt from persisted
   * `tool.approval_required` events, so a reloaded tab shows the same cards the live
   * stream already delivered.
   */
  listSentinelSessionContext: (sessionId: string) => Promise<SentinelSessionContext>;
};

/** Durable per-tool-call Sentinel state for one session. */
export type SentinelSessionContext = {
  approvals: SentinelApprovalInfo[];
  /** Answers already given, by tool call id. Absent when the host reads none. */
  answers?: Record<string, ApprovalAnswer> | undefined;
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

function tier2ActionKindArray(value: unknown): Tier2ActionKind[] {
  if (!Array.isArray(value)) return [];
  const kinds: Tier2ActionKind[] = [];
  for (const item of value) {
    const kind = parseTier2ActionKind(item);
    if (kind !== undefined && !kinds.includes(kind)) kinds.push(kind);
  }
  return kinds;
}

// Events reach the UI raw or through the SDK, which camel-cases the keys it knows.
function cardString(
  record: Record<string, unknown>,
  { snake, camel }: { snake: string; camel: string },
): string | null {
  return nullableString(record, snake) ?? nullableString(record, camel);
}

function cardFlag(record: Record<string, unknown>, { snake, camel }: { snake: string; camel: string }): boolean {
  return record[snake] === true || record[camel] === true;
}

const SEARCH_QUERY_MARKER = ' for: ';

// Search cards saved before the hold reason moved into plain_what: the reason was filed as
// "seen before", and a held key was written out in full. The key is not recoverable here, so the
// whole query is dropped for that case.
function readSavedHoldReason(card: SentinelApprovalCard): SentinelApprovalCard {
  const because = savedSearchHoldReason(card.why_asked_again);
  if (because === undefined) return card;
  if (because === SERVER_SECRET_REASON) {
    const marker = card.plain_what.indexOf(SEARCH_QUERY_MARKER);
    const heading = marker === -1 ? card.plain_what : card.plain_what.slice(0, marker);
    return {
      ...card,
      plain_what: `${heading}${heldBecause(SERVER_SECRET_REASON)}`,
      why_asked_again: null,
      outbound_text: null,
    };
  }
  return { ...card, plain_what: `${card.plain_what}${heldBecause(because)}`, why_asked_again: null };
}

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
    ? value.filter((item): item is string => typeof item === 'string')
    : undefined;
}

function parseEmailAction(value: unknown): SentinelApprovalEmailAction | undefined {
  return APPROVAL_EMAIL_ACTIONS.find(action => action === value);
}

function mailboxList(value: unknown): SentinelApprovalMailbox[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const mailboxes: SentinelApprovalMailbox[] = [];
  for (const item of value) {
    const mailbox = readStoredMailbox(item);
    if (mailbox === undefined) return undefined;
    mailboxes.push(mailbox);
  }
  return mailboxes;
}

function parseEmail(value: unknown): SentinelApprovalEmail | null {
  if (!isRecord(value)) return null;
  const action = parseEmailAction(value.action);
  const to = mailboxList(value.to);
  const cc = mailboxList(value.cc);
  const bcc = mailboxList(value.bcc);
  const subject = optionalString(value, 'subject');
  const body = optionalString(value, 'body');
  if (action === undefined || to === undefined || cc === undefined || bcc === undefined) return null;
  if (subject === undefined || body === undefined) return null;
  const replaced = value.replaces;
  const replacedSubject = isRecord(replaced) ? optionalString(replaced, 'subject') : undefined;
  const replacedTo = isRecord(replaced) ? mailboxList(replaced.to) : undefined;
  // The SDK camel-cases the keys it knows, so a card that came through it names this one replyInThread.
  const thread = value.reply_in_thread ?? value.replyInThread;
  const threadSubject = isRecord(thread) ? optionalString(thread, 'subject') : undefined;
  const threadFrom = isRecord(thread) ? optionalString(thread, 'from') : undefined;
  return {
    action,
    to,
    cc,
    bcc,
    subject,
    body,
    replaces:
      replacedSubject === undefined || replacedTo === undefined ? null : { subject: replacedSubject, to: replacedTo },
    reply_in_thread:
      threadSubject === undefined || threadFrom === undefined ? null : { subject: threadSubject, from: threadFrom },
  };
}

function parseCalendarAction(value: unknown): SentinelApprovalCalendarAction | undefined {
  return APPROVAL_CALENDAR_ACTIONS.find(action => action === value);
}

function parseCalendarBefore(value: unknown): SentinelApprovalCalendarEvent['before'] {
  if (!isRecord(value)) return null;
  const title = optionalString(value, 'title');
  const when = optionalString(value, 'when');
  const duration = optionalString(value, 'duration');
  const location = optionalString(value, 'location');
  if (title === undefined || when === undefined || duration === undefined || location === undefined) return null;
  return { title, when, duration, location };
}

/** A card missing any field is not shown as an event, so a partial event is never approved as if it were whole. */
function parseCalendarEvent(value: unknown): SentinelApprovalCalendarEvent | null {
  if (!isRecord(value)) return null;
  const action = parseCalendarAction(value.action);
  const calendar = optionalString(value, 'calendar');
  const title = optionalString(value, 'title');
  const when = optionalString(value, 'when');
  const time_zone = optionalString(value, 'time_zone') ?? optionalString(value, 'timeZone');
  const duration = optionalString(value, 'duration');
  const location = optionalString(value, 'location');
  const description = optionalString(value, 'description');
  const attendees = stringList(value.attendees);
  const guests_emailed = optionalBoolean(value, 'guests_emailed') ?? optionalBoolean(value, 'guestsEmailed');
  const one_of_repeating = optionalBoolean(value, 'one_of_repeating') ?? optionalBoolean(value, 'oneOfRepeating');
  if (
    action === undefined ||
    calendar === undefined ||
    title === undefined ||
    when === undefined ||
    time_zone === undefined ||
    duration === undefined ||
    location === undefined ||
    description === undefined ||
    attendees === undefined ||
    guests_emailed === undefined ||
    one_of_repeating === undefined
  ) {
    return null;
  }
  return {
    action,
    calendar,
    title,
    when,
    time_zone,
    duration,
    location,
    description,
    attendees,
    guests_emailed,
    one_of_repeating,
    before: parseCalendarBefore(value.before),
  };
}

/** A card missing any field is not shown as a schedule, so a partial schedule is never approved as if it were whole. */
function parseSchedule(value: unknown): SentinelApprovalSchedule | null {
  if (!isRecord(value)) return null;
  const action = APPROVAL_SCHEDULE_ACTIONS.find(candidate => candidate === value.action);
  const name = optionalString(value, 'name');
  const when = optionalString(value, 'when');
  const time_zone = optionalString(value, 'time_zone') ?? optionalString(value, 'timeZone');
  const task = optionalString(value, 'task');
  const runs_as = optionalString(value, 'runs_as') ?? optionalString(value, 'runsAs');
  const next_runs = stringList(value.next_runs ?? value.nextRuns);
  if (
    action === undefined ||
    name === undefined ||
    when === undefined ||
    time_zone === undefined ||
    task === undefined ||
    runs_as === undefined ||
    next_runs === undefined
  ) {
    return null;
  }
  return { action, name, when, time_zone, task, runs_as, next_runs };
}

function parseApprovalCard(value: unknown): SentinelApprovalCard | undefined {
  if (!isRecord(value)) return undefined;
  const plain_what = optionalString(value, 'plain_what') ?? optionalString(value, 'plainWhat');
  if (plain_what === undefined) return undefined;
  return readSavedHoldReason({
    plain_what,
    plain_why: cardString(value, { snake: 'plain_why', camel: 'plainWhy' }),
    cannot_be_undone: cardString(value, { snake: 'cannot_be_undone', camel: 'cannotBeUndone' }),
    why_asked_again: cardString(value, { snake: 'why_asked_again', camel: 'whyAskedAgain' }),
    destination: cardString(value, { snake: 'destination', camel: 'destination' }),
    recipient: cardString(value, { snake: 'recipient', camel: 'recipient' }),
    amount: cardString(value, { snake: 'amount', camel: 'amount' }),
    parsed_command: cardString(value, { snake: 'parsed_command', camel: 'parsedCommand' }),
    outbound_text: cardString(value, { snake: 'outbound_text', camel: 'outboundText' }),
    destination_host: cardString(value, { snake: 'destination_host', camel: 'destinationHost' }),
    outbound_truncated: cardFlag(value, { snake: 'outbound_truncated', camel: 'outboundTruncated' }),
    email: parseEmail(value.email),
    calendar_event: parseCalendarEvent(value.calendar_event ?? value.calendarEvent),
    schedule: parseSchedule(value.schedule),
  });
}

function toolCallIdFrom(record: Record<string, unknown>): string | undefined {
  return (
    optionalString(record, 'tool_call_id') ?? optionalString(record, 'id') ?? optionalString(record, 'approval_id')
  );
}

function parseHeldInfo(ref: Record<string, unknown>): HeldActionInfo | undefined {
  if (ref.held !== true) return undefined;
  return {
    alwaysAllowOffered: ref.can_always_allow === true || ref.canAlwaysAllow === true,
    expiresAt: nullableString(ref, 'expires_at') ?? nullableString(ref, 'expiresAt'),
  };
}

function parseNotSaved(ref: Record<string, unknown>): NotSavedReason | undefined {
  const value = ref.not_saved ?? ref.notSaved;
  return value === 'too_many' || value === 'helper_agent' ? value : undefined;
}

function parseApprovalInfo(
  ref: Record<string, unknown>,
  origin: { eventId: string | null; threadId: string | null },
): SentinelApprovalInfo | undefined {
  const tier = parseToolTier(ref.tier);
  const card = parseApprovalCard(ref.tier3_card ?? ref.tier3Card ?? ref.card);
  const toolCallId = toolCallIdFrom(ref);
  if (tier === undefined || card === undefined || toolCallId === undefined) return undefined;
  const held = parseHeldInfo(ref);
  const notSaved = parseNotSaved(ref);
  const chatAllowOffered = ref.can_chat_allow ?? ref.canChatAllow;
  return {
    toolCallId,
    tier,
    card,
    ...origin,
    ...(typeof chatAllowOffered === 'boolean' ? { chatAllowOffered } : {}),
    ...(held === undefined ? {} : { held }),
    ...(notSaved === undefined ? {} : { notSaved }),
  };
}

export const APPROVAL_REQUIRED_EVENT_TYPE = 'tool.approval_required';

function toolCallRefs(event: Record<string, unknown>): Record<string, unknown>[] {
  const refs = event.tool_calls ?? event.toolCalls;
  if (Array.isArray(refs)) return refs.filter(isRecord);
  // Single-action events may carry the per-action fields at the top level.
  return [event];
}

/**
 * Extracts Sentinel approval info from one raw session event. Accepts the parsed JSON
 * of either an SSE streaming event or a persisted session event; returns nothing for
 * events that carry no Sentinel data.
 */
export function extractSentinelFromEvent(event: unknown): SentinelApprovalInfo[] {
  if (!isRecord(event) || event.type !== APPROVAL_REQUIRED_EVENT_TYPE) return [];
  const origin = {
    eventId: optionalString(event, 'id') ?? null,
    threadId: optionalString(event, 'thread_id') ?? optionalString(event, 'threadId') ?? null,
  };
  const approvals: SentinelApprovalInfo[] = [];
  for (const ref of toolCallRefs(event)) {
    const approval = parseApprovalInfo(ref, origin);
    if (approval !== undefined) approvals.push(approval);
  }
  return approvals;
}

/**
 * The decisions a created turn carries as input. A held action is answered by a turn whose only
 * input is a `user.tool_approval`, so reading these tells a reloaded chat which cards are done.
 */
function answersFromEvent(event: unknown): [string, ApprovalAnswer][] {
  if (!isRecord(event) || event.type !== 'turn.created' || !Array.isArray(event.input)) return [];
  const answers: [string, ApprovalAnswer][] = [];
  for (const item of event.input) {
    if (!isRecord(item) || item.type !== 'user.tool_approval' || !isRecord(item.approval)) continue;
    const toolCallId = optionalString(item, 'tool_call_id') ?? optionalString(item, 'toolCallId');
    if (toolCallId === undefined) continue;
    if (item.approval.status === 'allow') answers.push([toolCallId, 'approved']);
    if (item.approval.status === 'deny') answers.push([toolCallId, 'denied']);
  }
  return answers;
}

/** Folds raw session events into per-tool-call Sentinel state (later events win). */
export function extractSentinelSessionContext(events: unknown[]): SentinelSessionContext {
  const approvals = new Map<string, SentinelApprovalInfo>();
  const answers: Record<string, ApprovalAnswer> = {};
  for (const event of events) {
    for (const approval of extractSentinelFromEvent(event)) approvals.set(approval.toolCallId, approval);
    for (const [toolCallId, answer] of answersFromEvent(event)) answers[toolCallId] = answer;
  }
  return { approvals: [...approvals.values()], answers };
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

/** Parses a per-user audit page (`{ data: [...], pagination }`); rows that fail to parse are dropped. */
export function parseUserAuditPage(body: unknown): SentinelUserAuditPage {
  if (!isRecord(body) || !Array.isArray(body.data)) return { entries: [] };
  const entries: SentinelUserAuditEntry[] = [];
  for (const item of body.data) {
    const entry = parseAuditEntry(item);
    if (entry === undefined || !isRecord(item) || typeof item.chat_exists !== 'boolean') continue;
    entries.push({ ...entry, chat_exists: item.chat_exists });
  }
  const pagination = isRecord(body.pagination) ? body.pagination : undefined;
  const nextPageToken = pagination === undefined ? undefined : optionalString(pagination, 'next_page_token');
  return nextPageToken === undefined || nextPageToken === '' ? { entries } : { entries, nextPageToken };
}

/** Parses a settings response body (`{ data: settings }`); absent fields fall back to safe defaults. */
export function parseUserSettings(body: unknown): SentinelUserSettings {
  const settings = isRecord(body) ? body.data : undefined;
  if (!isRecord(settings)) {
    return { offline_mode: false, tier2_auto_allow: [], search_without_asking: true, maps_without_asking: false };
  }
  return {
    offline_mode: optionalBoolean(settings, 'offline_mode') ?? false,
    tier2_auto_allow: tier2ActionKindArray(settings.tier2_auto_allow),
    search_without_asking: optionalBoolean(settings, 'search_without_asking') ?? true,
    maps_without_asking: optionalBoolean(settings, 'maps_without_asking') ?? false,
  };
}

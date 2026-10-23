import {
  ALLOWED_BY_SETTINGS_LABEL,
  WAITING_FOR_YOU_LABEL,
  type SentinelAuditEntry,
  type SentinelAuditOutcome,
} from './types.js';

/**
 * The one owner of the receipt's words: what each tool call reads as, and the state each audit
 * outcome ends on. Plain words only; the raw tool name stays behind Details.
 */

/** The five states a receipt row can end on. `waiting` comes from a pending approval, not an audit entry. */
export const ACTIVITY_STATES = ['waiting', 'approved', 'declined', 'turned_down', 'allowed'] as const;

export type ActivityState = (typeof ACTIVITY_STATES)[number];

export const ACTIVITY_STATE_LABELS: Record<ActivityState, string> = {
  waiting: WAITING_FOR_YOU_LABEL,
  approved: 'Approved',
  declined: 'Declined',
  turned_down: 'Blocked',
  allowed: ALLOWED_BY_SETTINGS_LABEL,
};

/** The dot before a state word, as theme token classes only. */
export const ACTIVITY_STATE_DOT_CLASSES: Record<ActivityState, string> = {
  waiting: 'bg-gold',
  approved: 'bg-success-bg',
  declined: 'bg-text-secondary',
  turned_down: 'bg-failure-bg',
  allowed: 'bg-text-secondary/50',
};

const OUTCOME_STATES: Record<Exclude<SentinelAuditOutcome, 'logged'>, ActivityState> = {
  ran: 'allowed',
  approved: 'approved',
  denied: 'declined',
  auto_denied: 'turned_down',
};

/**
 * A `logged` row is a Tier 1 read that ran under the person's settings (allowed), or a Tier 2 or 3
 * call waiting for them. The stored tier tells them apart.
 */
export function activityStateOf(entry: Pick<SentinelAuditEntry, 'outcome' | 'tier'>): ActivityState {
  if (entry.outcome === 'logged') return entry.tier === 1 ? 'allowed' : 'waiting';
  return OUTCOME_STATES[entry.outcome];
}

function verbs(verb: string, toolNames: readonly string[]): [string, string][] {
  return toolNames.map(toolName => [toolName, verb]);
}

/** Used for a tool the table does not know yet, so a new tool never shows its raw name. */
export const ACTIVITY_FALLBACK_VERB = 'Used a connected app';

// Keyed by the tool name the server records; the older action kinds stay so earlier rows still read well.
const ACTION_VERBS: ReadonlyMap<string, string> = new Map([
  ...verbs('Read your email', [
    'read_email',
    'get_thread',
    'search_emails',
    'list_inbox_threads',
    'get_inbox_with_threads',
    'list_emails_metadata',
    'get_attachment_content',
    'download_attachment',
    'list_drafts',
    'get_draft',
    'gmail_read',
  ]),
  ...verbs('Saved a draft', ['draft_email', 'update_draft', 'gmail_draft']),
  ...verbs('Sent an email', ['send_draft', 'gmail_send']),
  ...verbs('Read your calendar', ['list_events', 'get_event', 'calendar_read']),
  ...verbs('Changed your calendar', ['create_event', 'update_event', 'calendar_write']),
  ...verbs('Searched the web', ['tavily_search', 'web_search']),
  ...verbs('Read a web page', ['tavily_extract']),
  ...verbs('Looked up a map', ['render_map']),
  ...verbs('Planned a route', ['render_route']),
  ...verbs('Looked up places', ['render_places']),
  ...verbs('Checked the weather', ['get_weather']),
  ...verbs('Ran a command', ['exec', 'sandbox_command', 'run_registered_command']),
  ...verbs('Ran code', ['run_code']),
  ...verbs('Wrote a file', ['write_file']),
  ...verbs('Changed files', ['apply_patch']),
  ...verbs('Read a space', ['get_space', 'list_spaces', 'list_blocks', 'space_read']),
  ...verbs('Changed a space', ['create_space', 'update_space', 'replace_text', 'revert_space', 'space_write']),
  ...verbs('Checked a schedule', ['list_schedules', 'schedule_read']),
  ...verbs('Changed a schedule', [
    'create_schedule',
    'delete_schedule',
    'pause_schedule',
    'resume_schedule',
    'schedule_write',
  ]),
  ...verbs('Checked a specialist', ['list_personas', 'persona_read']),
  ...verbs('Switched specialist', ['use_persona', 'persona_switch']),
  ...verbs('Made a specialist', ['create_persona']),
  ...verbs('Showed a picture', ['show_image']),
  ...verbs('Made a report', ['create_document_report']),
  ...verbs('Made a plan', ['submit_implementation_plan']),
]);

export function activityVerbOf(actionType: string): string {
  return ACTION_VERBS.get(actionType) ?? ACTIVITY_FALLBACK_VERB;
}

/** One receipt row: the entries that share a verb and a state. */
export type ReceiptRow = {
  key: string;
  verb: string;
  state: ActivityState;
  /** ISO time of the newest entry in the row. */
  latestAt: string;
};

/** Groups audit entries by verb and state, newest row first. */
export function receiptRowsOf(entries: readonly SentinelAuditEntry[]): ReceiptRow[] {
  const rows = new Map<string, ReceiptRow>();
  for (const entry of entries) {
    const verb = activityVerbOf(entry.action_type);
    const state = activityStateOf(entry);
    const key = `${state}:${verb}`;
    const existing = rows.get(key);
    if (existing === undefined) {
      rows.set(key, { key, verb, state, latestAt: entry.created_at });
      continue;
    }
    if (Date.parse(entry.created_at) > Date.parse(existing.latestAt)) existing.latestAt = entry.created_at;
  }
  return [...rows.values()].sort((a, b) => Date.parse(b.latestAt) - Date.parse(a.latestAt));
}

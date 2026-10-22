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
  approved: 'You approved',
  declined: 'You declined',
  turned_down: 'Turned down automatically',
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

/** Used for a tool the table does not know yet, so a new tool never shows its raw name. */
export const ACTIVITY_FALLBACK_VERB = 'Used a connected app';

const ACTION_VERBS: ReadonlyMap<string, string> = new Map([
  ['gmail_read', 'Read your email'],
  ['gmail_draft', 'Saved a draft'],
  ['gmail_send', 'Sent an email'],
  ['calendar_read', 'Read your calendar'],
  ['calendar_write', 'Changed your calendar'],
  ['web_search', 'Searched the web'],
  ['render_map', 'Looked up a map'],
  ['render_route', 'Planned a route'],
  ['render_places', 'Looked up places'],
  ['exec', 'Ran a command'],
  ['sandbox_command', 'Ran a command'],
  ['run_code', 'Ran code'],
  ['write_file', 'Wrote a file'],
  ['apply_patch', 'Changed files'],
  ['space_read', 'Read a space'],
  ['space_write', 'Changed a space'],
  ['schedule_read', 'Checked a schedule'],
  ['schedule_write', 'Changed a schedule'],
  ['persona_read', 'Checked a specialist'],
  ['persona_switch', 'Switched specialist'],
  ['submit_implementation_plan', 'Made a plan'],
]);

export function activityVerbOf(actionType: string): string {
  return ACTION_VERBS.get(actionType) ?? ACTIVITY_FALLBACK_VERB;
}

/** One receipt row: the same verb and state, counted over the entries it stands for. */
export type ReceiptRow = {
  key: string;
  verb: string;
  state: ActivityState;
  count: number;
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
      rows.set(key, { key, verb, state, count: 1, latestAt: entry.created_at });
      continue;
    }
    existing.count += 1;
    if (Date.parse(entry.created_at) > Date.parse(existing.latestAt)) existing.latestAt = entry.created_at;
  }
  return [...rows.values()].sort((a, b) => Date.parse(b.latestAt) - Date.parse(a.latestAt));
}

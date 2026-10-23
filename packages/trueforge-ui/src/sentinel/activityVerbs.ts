import { toolDoneWords } from '../utils/toolWords.js';
import {
  ALLOWED_BY_SETTINGS_LABEL,
  WAITING_FOR_YOU_LABEL,
  type SentinelAuditEntry,
  type SentinelAuditOutcome,
} from './types.js';

/**
 * The one owner of the receipt's state words: the state each audit outcome ends on. What each tool
 * call reads as comes from the shared tool words; the raw tool name stays behind Details.
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
    const verb = toolDoneWords(entry.action_type);
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

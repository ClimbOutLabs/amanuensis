import { ALLOWED_BY_SETTINGS_LABEL, WAITING_FOR_YOU_LABEL, type SentinelAuditEntry } from './types.js';

/**
 * The one owner of the rail's activity words: what each tool call is called, the line each
 * action ends on, and how the rows are grouped into replies. Plain words only; the raw tool
 * name stays behind Details.
 */

/** The line under a row's title. */
export const ACTIVITY_SUBTITLES = {
  doneAllowed: ALLOWED_BY_SETTINGS_LABEL,
  approved: 'You approved',
  declined: 'You declined',
  waiting: WAITING_FOR_YOU_LABEL,
} as const;

/** The line for an action that could not run; the reason is short and plain. */
export function activityFailedSubtitle(reason: string): string {
  return `Failed: ${reason}`;
}

/** The mark before a row: done, declined, failed, or a dot while it still waits on the person. */
type ActivityMark = '✓' | '–' | '!' | '·';

/** One row of the Recent actions list, already in the words the person reads. */
export type ActivityRow = {
  id: string;
  title: string;
  subtitle: string;
  mark: ActivityMark;
  failed: boolean;
  createdAt: string;
};

type ActionWords = { service: string; action: string };

/** Keyed by the audit row's tool name. Every entry names the real service it touched. */
const ACTION_WORDS: ReadonlyMap<string, ActionWords> = new Map([
  ['gmail_read', { service: 'Gmail', action: 'read email' }],
  ['gmail_draft', { service: 'Gmail', action: 'saved a draft' }],
  ['gmail_send', { service: 'Gmail', action: 'sent an email' }],
  ['calendar_read', { service: 'Calendar', action: 'read events' }],
  ['calendar_write', { service: 'Calendar', action: 'changed an event' }],
  ['web_search', { service: 'Web search', action: 'searched the web' }],
  ['render_map', { service: 'Maps', action: 'looked up a map' }],
  ['render_route', { service: 'Maps', action: 'planned a route' }],
  ['render_places', { service: 'Maps', action: 'looked up places' }],
  ['exec', { service: 'Sandbox', action: 'ran a command' }],
  ['sandbox_command', { service: 'Sandbox', action: 'ran a command' }],
  ['run_code', { service: 'Sandbox', action: 'ran code' }],
  ['write_file', { service: 'Files', action: 'wrote a file' }],
  ['apply_patch', { service: 'Files', action: 'changed files' }],
  ['space_read', { service: 'Spaces', action: 'read a space' }],
  ['space_write', { service: 'Spaces', action: 'changed a space' }],
  ['schedule_read', { service: 'Schedule', action: 'checked the schedule' }],
  ['schedule_write', { service: 'Schedule', action: 'changed the schedule' }],
  ['persona_read', { service: 'Specialists', action: 'checked a specialist' }],
  ['persona_switch', { service: 'Specialists', action: 'switched specialist' }],
  ['submit_implementation_plan', { service: 'Plan', action: 'made a plan' }],
]);

/** A tool the table does not know yet reads as its own name, sentence case, never "connected app". */
function displayNameOf(actionType: string): string {
  const spaced = actionType.replace(/_/g, ' ').trim();
  return spaced === '' ? actionType : spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** The row title: the real service, then what it did. */
export function activityTitleOf(actionType: string): string {
  const words = ACTION_WORDS.get(actionType);
  return words === undefined ? displayNameOf(actionType) : `${words.service} · ${words.action}`;
}

/** The auto-denied reason, in the words the person reads. */
const AUTO_DENIED_REASON = 'blocked by your settings';

/** Maps one audit row to its mark and line. Only an auto-denied action reads as failed. */
export function activityRowOf(entry: SentinelAuditEntry): ActivityRow {
  const base = { id: entry.id, title: activityTitleOf(entry.action_type), createdAt: entry.created_at };
  switch (entry.outcome) {
    case 'ran':
      return { ...base, subtitle: ACTIVITY_SUBTITLES.doneAllowed, mark: '✓', failed: false };
    case 'approved':
      return { ...base, subtitle: ACTIVITY_SUBTITLES.approved, mark: '✓', failed: false };
    case 'denied':
      return { ...base, subtitle: ACTIVITY_SUBTITLES.declined, mark: '–', failed: false };
    case 'auto_denied':
      return {
        ...base,
        subtitle: activityFailedSubtitle(AUTO_DENIED_REASON),
        mark: '!',
        failed: true,
      };
    case 'logged':
      // A Tier 1 read that ran without asking; anything else is held until the person answers.
      return entry.tier === 1
        ? { ...base, subtitle: ACTIVITY_SUBTITLES.doneAllowed, mark: '✓', failed: false }
        : { ...base, subtitle: ACTIVITY_SUBTITLES.waiting, mark: '·', failed: false };
  }
}

/** Audit rows carry no turn id, so rows closer together than this count as one reply. */
const REPLY_GAP_MS = 10 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

type ActivityGroup = {
  /** The newest row's time, which keys the group. */
  key: string;
  label: 'This reply' | 'Earlier today' | 'Yesterday' | 'Earlier';
  rows: ActivityRow[];
};

function sameLocalDay({ a, b }: { a: Date; b: Date }): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function groupLabelOf({ newest, index, now }: { newest: Date; index: number; now: Date }): ActivityGroup['label'] {
  if (index === 0 && now.getTime() - newest.getTime() <= REPLY_GAP_MS) return 'This reply';
  if (sameLocalDay({ a: newest, b: now })) return 'Earlier today';
  if (sameLocalDay({ a: newest, b: new Date(now.getTime() - DAY_MS) })) return 'Yesterday';
  return 'Earlier';
}

/** Groups the rows into replies, newest first. Each group is labelled by when it happened. */
export function groupActivityRows({
  entries,
  now,
}: {
  entries: readonly SentinelAuditEntry[];
  now: Date;
}): ActivityGroup[] {
  const sorted = [...entries].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  const groups: { rows: SentinelAuditEntry[]; newest: Date }[] = [];
  let previousTime = Number.NaN;
  for (const entry of sorted) {
    const time = Date.parse(entry.created_at);
    const current = groups.at(-1);
    if (current === undefined || previousTime - time > REPLY_GAP_MS) {
      groups.push({ rows: [entry], newest: new Date(time) });
    } else {
      current.rows.push(entry);
    }
    previousTime = time;
  }
  return groups.map((group, index) => ({
    key: group.rows[0]?.id ?? String(index),
    label: groupLabelOf({ newest: group.newest, index, now }),
    rows: group.rows.map(activityRowOf),
  }));
}

/** "just now", "2m ago", "3h ago", "4d ago": short enough for the rail's one line. */
export function relativeTimeLabel({ iso, now }: { iso: string; now: Date }): string {
  const elapsed = Math.max(0, now.getTime() - Date.parse(iso));
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
